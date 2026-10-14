# Robot vacuum (Dreame)

The Robot vacuum widget shows a Dreame robot's status and battery, and lets you start, pause, stop and dock it, clean chosen rooms, change suction and mop mode, and run the station (empty the dust bin, wash or dry the mops). On big tiles it draws the robot's saved floor map, and you can tap rooms on it to pick them.

It was built for the **Dreame L40 Ultra**, and should work with other Dreame robots that use the Dreamehome app.

## How it works, and the catch

Dreame has no public API. PiDisplay signs in to the same cloud the Dreamehome app uses, the way the community [dreame-vacuum](https://github.com/Tasshack/dreame-vacuum) Home Assistant integration does, and sends the robot the same commands the app sends. That means:

- **It is unofficial.** Dreame can change its cloud at any time and the widget can stop working until it is updated.
- **It needs your Dreamehome email and password.** They are stored only on the Pi, in `~/pidisplay-data/dreame.json` (readable by your user only). They are never in git and never sent to the screen or browser. The Pi talks only to Dreame's servers.
- A sign-in from the Pi looks like another phone signing in. It does not sign the app out.
- Nothing runs on the robot itself, and nothing about the robot changes except what you tap.

## Set it up

1. Deploy as usual: `.\deploy\deploy.ps1`.
2. Save your login on the Pi (from the pidisplay folder on the laptop):

   ```powershell
   .\deploy\vacuum.ps1 -Email you@example.com
   ```

   It asks for the password (nothing is shown as you type), saves it on the Pi, signs in and prints the robot it found and its rooms.
3. On the display, tap ✎, add a **Robot vacuum** tile and pick a size. Tall and bigger tiles show the rooms; extra-large and full tiles show the map.

### Options

| Command | What it does |
| --- | --- |
| `.\deploy\vacuum.ps1` | Shows whether PiDisplay can reach the robot. |
| `.\deploy\vacuum.ps1 -Email you@example.com -Region eu` | For an account on another Dreame server: `us` (default), `eu`, `cn`, `ru`, `sg`. Use the region your account was created in. |
| `.\deploy\vacuum.ps1 -Email you@example.com -Robot "Downstairs"` | With several robots on the account, picks one by its name in the app. Otherwise the first robot vacuum is used. |
| `.\deploy\vacuum.ps1 -Remove` | Deletes the saved login and the cached rooms from the Pi. |

### Signed in with Google or Apple?

The widget needs an email and password. If you use Google or Apple to sign in to the Dreamehome app, set a password for the account in the app first (Profile, account settings), then use that email and password here.

## Using it

- **Clean all** starts a full clean. Tap room chips (or rooms on the map) and the button becomes **Clean N rooms**.
- While it runs, the main button is **Pause**, then **Resume**. **Dock** sends it home.
- **Suction** and **Mode** change the robot's settings, the same as in the app.
- **More** opens everything: Stop, Find robot (it speaks), Empty dust bin, Wash mops, Dry mops, and how much life the brushes, filter and mop pads have left.
- When the robot reports a new problem (stuck, tank empty, dirty water tank full) a notification pops up on the display.

The widget checks the robot every 10 seconds while it is cleaning and every minute otherwise. Rooms and the map are re-read every few hours, or as soon as the robot saves a new map.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "Dreame refused the sign-in" | Check the email and password, and try `-Region`. Run `vacuum.ps1 -Email ...` again to save the fix. |
| "No robot vacuum on this Dreamehome account" | The robot is on another account, or on a different region's server. |
| "Can't reach Dreame" | The Pi is offline or Dreame's cloud is down. It retries on its own. |
| No rooms or no map | The robot has no saved map yet, or this model stores it differently. Clean all and the other buttons still work. |
| A button does nothing | Watch `journalctl -u pidisplay -f` on the Pi while you tap it, and note the error. |
