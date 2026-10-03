# Photos

The Photos widget is a slideshow with a crossfade. Tap it for ◀ ⏸ ▶▶ and ▦ (a thumbnail grid to jump to any photo, filtered by album). Each tile can show everything, only uploaded photos, only Google albums, or one album by name, with its own speed, shuffle and fit.

Photos come from two places, and you can use both.

## 1. Upload folders from the laptop

From the `pidisplay` folder on the laptop:

```powershell
.\deploy\photos.ps1 -Upload "C:\Users\Laptop\Pictures\Beach 2026"          # album named after the folder
.\deploy\photos.ps1 -Upload "C:\Users\Laptop\Pictures\Phone dump" -Album Family
.\deploy\photos.ps1                                                       # list albums
.\deploy\photos.ps1 -Remove "Beach 2026"                                  # delete that album from the Pi
```

Photos land in `~/pidisplay-data/photos/<album>/` on the Pi (redeploys never touch it). Running `-Upload` again on the same folder only sends new or changed files. JPEG, PNG, WebP and GIF work; iPhone HEIC photos work when the Pi's ImageMagick can read them, and `photos.ps1` warns if it can't (export them as JPEG then).

The Pi shrinks each photo to screen size (and a small thumbnail) with ImageMagick, in the background at low priority, and keeps the results in `~/pidisplay-data/photos-cache/`. A big upload takes a while to finish shrinking; photos that aren't ready yet are shrunk the moment they come up.

You can also drop photos into that folder any other way (a USB stick, `scp`, a sync tool such as Syncthing): one subfolder per album, and loose files show as the album "Photos".

## 2. Google Photos shared albums

Google stopped letting personal apps read your Google Photos library in March 2025. What still works without any developer setup is an album shared by link:

1. In Google Photos (phone or web), open or create an album.
2. Tap **Share**, then **Create link** / **Copy link**. It looks like `https://photos.app.goo.gl/...`.
3. On the laptop: `.\deploy\photos.ps1 -Album Family -Url "https://photos.app.goo.gl/..."`

Anything you add to that album later shows up on the display within about 30 minutes. Notes:

- Anyone with the link can view the album; the link is kept only on the Pi in `~/pidisplay-data/photos.json`.
- This reads the album's public web page, which Google doesn't officially support. If Google changes that page, the album shows a "No photos found" problem in `photos.ps1` and the widget's ▦ sheet, and uploaded photos keep working.
- Very large albums (several hundred photos) may only show the first few hundred.
- Google sizes these photos for the screen itself, so they cost the Pi nothing extra.

## Other services

- **iCloud shared album** (public website on): possible the same way as Google; ask for it.
- **Immich** (self-hosted Google Photos replacement): has a proper API with keys; worth it if you run an Immich server.
- **OneDrive / Dropbox / Google Drive folder**: sync it into `~/pidisplay-data/photos/<album>/` with `rclone` on a timer.
