"""Click at x,y on the X display in $DISPLAY with the XTest extension (what
xdotool does), for screenshots of the desktop app under Xvfb.

    python3 scripts/screenshots/x11-click.py 305 24

Needs libX11 and libXtst, which WebKitGTK already pulls in.
"""
import ctypes
import sys
import time

x11 = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

x, y = int(sys.argv[1]), int(sys.argv[2])
display = x11.XOpenDisplay(None)
if not display:
    sys.exit("x11-click: cannot open the display in $DISPLAY")
xtst.XTestFakeMotionEvent(display, -1, x, y, 0)
x11.XFlush(display)
time.sleep(0.15)
xtst.XTestFakeButtonEvent(display, 1, 1, 0)
x11.XFlush(display)
time.sleep(0.05)
xtst.XTestFakeButtonEvent(display, 1, 0, 0)
x11.XFlush(display)
x11.XCloseDisplay(display)
