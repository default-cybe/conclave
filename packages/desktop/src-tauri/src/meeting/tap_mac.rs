// The meeting's sound on macOS 14.4+, whatever device it plays on: a Core Audio
// global process tap (every process but this one, mixed to stereo) behind a
// private aggregate device that cpal then records like a mic. AirPods, the
// speakers or a meeting app's own output device: the tap hears all of them, and
// a headphone switch mid-meeting changes nothing.
//
// The tap and aggregate device setup is adapted from
// RustAudio/cpal@v0.18.2:src/host/coreaudio/macos/loopback.rs (LoopbackDevice,
// create_audio_aggregate_device_properties), with insidegui/AudioCap's global
// tap description in mind (initStereoGlobalTapButExcludeProcesses, no device UID).
// Original licence: Apache-2.0. Copyright (c) The CPAL contributors.
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use
// this file except in compliance with the License. You may obtain a copy of the
// License at http://www.apache.org/licenses/LICENSE-2.0. Unless required by
// applicable law or agreed to in writing, software distributed under the License
// is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the specific language
// governing permissions and limitations under the License.
// Changed here: a global tap that excludes this process instead of a tap on one
// output device, and errors as strings for the capture worker.

use std::ffi::{c_void, CStr};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, Ordering};

use objc2::{rc::Retained, AnyThread};
use objc2_core_audio::{
    kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapAutoStartKey, kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey,
    kAudioEndPointDeviceIsPrivateKey, kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
    AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
    AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress, CATapDescription, CATapMuteBehavior,
};
use objc2_core_foundation::{
    kCFAllocatorDefault, kCFTypeArrayCallBacks, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks, CFArray, CFDictionary,
    CFMutableDictionary, CFRetained, CFString,
};
use objc2_foundation::{NSArray, NSNumber, NSString};

static INSTANCE: AtomicU32 = AtomicU32::new(0);

/// The tap and its aggregate device; both are destroyed on drop (after the stream on it).
pub struct GlobalTap {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    /// The aggregate device's UID: cpal finds the device by it.
    pub uid: String,
}

impl GlobalTap {
    pub fn new() -> Result<Self, String> {
        let pid = std::process::id();
        let n = INSTANCE.fetch_add(1, Ordering::Relaxed);
        // our own sound (none today) stays out; a process that never played has no object yet
        let exclude: Retained<NSArray<NSNumber>> = match own_process_object(pid) {
            Some(id) => NSArray::from_retained_slice(&[NSNumber::new_u32(id)]),
            None => NSArray::new(),
        };
        let desc = unsafe { CATapDescription::initStereoGlobalTapButExcludeProcesses(CATapDescription::alloc(), &exclude) };
        unsafe {
            // the owner still hears the meeting
            desc.setMuteBehavior(CATapMuteBehavior::Unmuted);
            desc.setName(&NSString::from_str(&format!("Conclave meeting tap {pid}.{n}")));
            desc.setPrivate(true);
        }
        let mut tap: AudioObjectID = 0;
        let s = unsafe { AudioHardwareCreateProcessTap(Some(desc.as_ref()), &mut tap) };
        if s != 0 {
            return Err(format!("AudioHardwareCreateProcessTap failed ({s})"));
        }
        let tap_uid = unsafe { desc.UUID().UUIDString() };
        let uid = format!("dev.conclave.meeting-tap.{pid}.{n}");
        let props = aggregate_properties(tap_uid, &uid, "Conclave meeting tap");
        let mut aggregate: AudioObjectID = 0;
        let s = unsafe { AudioHardwareCreateAggregateDevice(props.as_ref(), NonNull::from(&mut aggregate)) };
        if s != 0 {
            unsafe { AudioHardwareDestroyProcessTap(tap) };
            return Err(format!("AudioHardwareCreateAggregateDevice failed ({s})"));
        }
        Ok(Self { tap, aggregate, uid })
    }
}

impl Drop for GlobalTap {
    fn drop(&mut self) {
        unsafe {
            AudioHardwareDestroyAggregateDevice(self.aggregate);
            AudioHardwareDestroyProcessTap(self.tap);
        }
    }
}

/// kAudioHardwarePropertyTranslatePIDToProcessObject for `pid`, if Core Audio knows it.
fn own_process_object(pid: u32) -> Option<AudioObjectID> {
    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let pid = pid as i32;
    let mut out: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let s = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&addr),
            std::mem::size_of::<i32>() as u32,
            &pid as *const i32 as *const c_void,
            NonNull::from(&mut size),
            NonNull::from(&mut out).cast(),
        )
    };
    (s == 0 && out != 0).then_some(out)
}

fn to_cfstring(cstr: &'static CStr) -> CFRetained<CFString> {
    unsafe { CFString::with_c_string(kCFAllocatorDefault, cstr.as_ptr(), 0x08000100 /* UTF8 */) }.unwrap()
}

/// The private aggregate device that holds only the tap (cpal's create_audio_aggregate_device_properties).
fn aggregate_properties(tap_uid: Retained<NSString>, agg_uid: &str, agg_name: &str) -> CFRetained<CFDictionary> {
    let tap_inner = unsafe {
        let dict = CFMutableDictionary::new(kCFAllocatorDefault, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks).unwrap();
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioSubTapUIDKey) as *const _ as *const c_void,
            &*tap_uid as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioSubTapDriftCompensationKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );
        dict
    };
    let taps_list = [tap_inner];
    let taps = unsafe { CFArray::new(kCFAllocatorDefault, taps_list.as_ptr() as *mut *const c_void, taps_list.len() as _, &kCFTypeArrayCallBacks).unwrap() };
    unsafe {
        let dict = CFMutableDictionary::new(kCFAllocatorDefault, 5, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks).unwrap();
        let set = |k: &'static CStr, v: *const c_void| CFMutableDictionary::set_value(Some(dict.as_ref()), &*to_cfstring(k) as *const _ as *const c_void, v);
        set(kAudioAggregateDeviceNameKey, &*CFString::from_str(agg_name) as *const _ as *const c_void);
        set(kAudioAggregateDeviceUIDKey, &*CFString::from_str(agg_uid) as *const _ as *const c_void);
        set(kAudioAggregateDeviceTapListKey, &*taps as *const _ as *const c_void);
        set(kAudioAggregateDeviceTapAutoStartKey, &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void);
        set(kAudioEndPointDeviceIsPrivateKey, &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void);
        CFRetained::cast_unchecked::<CFDictionary>(dict)
    }
}
