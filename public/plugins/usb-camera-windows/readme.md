# USB Camera

Adjust a USB webcam from KnobDeck: sliders and switches for every control the camera supports.
Works on Linux and Windows, with any UVC (USB Video Class) camera, including while OBS, a browser
or a meeting app is using it. A camera shows only what it really has; an action for a control the
camera lacks says "Not supported" on its key.

## What it does

- **Sliders** (dial or key), each 0–100 % of the camera's own range, showing the real value on
  the key: Brightness, Contrast, Saturation, Hue, Sharpness, Gamma, Gain, Backlight Compensation,
  White Balance (Kelvin), Exposure, Focus, Zoom, Pan, Tilt (degrees), Roll, Iris. A turn moves
  at least one of the camera's own steps, so a 0–12 zoom still moves one level per click.
- **Switches** for the auto modes: Auto Exposure, Auto White Balance, Autofocus, Auto Hue.
- **Camera Control**, **Camera Switch**, **Camera Option**: pick any control the camera
  reports from a list (a slider, an on/off switch, or a list of options such as Power Line
  Frequency that each press steps through). This covers everything beyond the standard set, such as
  Red / Blue Balance, a privacy shutter or a driver's own extras.
- **Set Camera Control** puts a control at a fixed position; **Reset Camera Control** returns
  one control, or all of them, to the camera's own defaults.
- Pick the **Camera** per action when more than one is connected; the default is the first found.
  Keys follow changes made elsewhere (every 2 seconds).

A manual control does nothing while its auto mode is on (Exposure with Auto Exposure on). The
plugin tells you ("Turn off Auto Exposure first") and never switches the auto mode for you.

## How it works

- **Linux:** V4L2. The controls are read from the driver (`VIDIOC_QUERY_EXT_CTRL`), so whatever the
  camera advertises appears, with its real range and step. Needs access to `/dev/video*` (the
  `video` group, which desktop distributions grant to the logged-in user).
- **Windows:** DirectShow `IAMVideoProcAmp` (image controls) and `IAMCameraControl` (pan, tilt,
  roll, zoom, exposure, iris, focus), the interfaces other camera apps use. Windows exposes no
  menu controls (power line frequency, for example).
- Only USB cameras are listed (virtual cameras such as OBS's are left out).
- Continuous controls that keep moving until stopped (UVC "relative" and "speed" controls, such as
  continuous zoom and pan speed) aren't shown; the absolute controls cover pan, tilt, zoom, focus
  and iris.
- macOS isn't supported yet.

No setup is needed.
