# kotlinx.serialization ships its own R8 rules; keep our generated serializers explicitly too.
-keepattributes *Annotation*, InnerClasses, Signature
-dontnote kotlinx.serialization.**
-keep,includedescriptorclasses class dev.conclave.**$$serializer { *; }
-keepclassmembers class dev.conclave.** {
    *** Companion;
}
-keepclasseswithmembers class dev.conclave.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# OkHttp and Tink optional dependencies.
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn com.google.api.client.**
-dontwarn org.joda.time.**

# ML Kit finds its parts by name at run time: MlKitComponentDiscoveryService reads the registrar
# class names from the manifest and builds each one with its no-argument constructor. R8 full mode
# drops what nothing references directly, and BarcodeScanning.getClient then throws a
# NullPointerException as the scanner opens (the v0.2.0 release APK did).
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_barcode.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_common.** { *; }
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }

# The bundled barcode model (com.google.mlkit:barcode-scanning, not the Play services one) lives in
# packages the rules above do not match: its own internal package (a "_bundled" suffix is another
# package, not a sub-package) and the barhopper decoder, whose native library calls back into Java
# classes by name and hands back protos that protobuf-lite reads by field name. A rename there throws
# at the first frame the scanner reads, after it opened fine.
-keep class com.google.android.gms.internal.mlkit_vision_barcode_bundled.** { *; }
-keep class com.google.android.gms.internal.mlkit_common.** { *; }
-keep class com.google.android.libraries.barhopper.** { *; }
-keep class com.google.photos.vision.barhopper.** { *; }
-dontwarn com.google.android.libraries.barhopper.**
-dontwarn com.google.photos.vision.barhopper.**
