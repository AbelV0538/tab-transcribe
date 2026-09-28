# Tab Transcribe

Turn a recording or video of **guitar and/or bass** into **playable tablature**.

Pick an audio or video file. The app:

1. **Listens for notes** with Spotify's [Basic Pitch](https://github.com/spotify/basic-pitch), a lightweight polyphonic neural transcription model that runs on the device.
2. **Detects which instrument is playing** (guitar, bass, or both) and splits the notes between them.
3. **Chooses the most likely, playable interpretation**:
   - removes overtone "ghost" notes and duplicate detections;
   - keeps the bass line monophonic;
   - picks the tuning (standard, drop D, E♭, 5-string bass, …);
   - finds the most natural fingering on the fretboard;
   - tracks the beat and snaps notes to a 16th-note or triplet grid.
4. Shows the result as **tab**, with a cursor that follows playback of the original (at 50%, 75% or 100% speed) or of a synthesised rendering of the transcription.
5. **Exports** the result as a plain-text tab (`.txt`), a MIDI file (`.mid`), or MusicXML with tablature (`.musicxml`). MusicXML opens in MuseScore, Guitar Pro, TuxGuitar, Sibelius and similar apps.

Everything runs locally: recordings are never uploaded.

The same code builds a desktop/web app and a native **Android** and **iOS** app via [Capacitor](https://capacitorjs.com).

---

## Build it on your computer and install it on your phone

### Prerequisites

| For | You need |
| --- | --- |
| Everything | [Node.js 22+](https://nodejs.org) |
| Android APK | [Android Studio](https://developer.android.com/studio) (installs the Android SDK) and JDK 21 (bundled with Android Studio) |
| iPhone/iPad | A Mac with Xcode 16+ and an Apple ID |

```bash
git clone https://github.com/AbelV0538/tab-transcribe.git
cd tab-transcribe
npm install
```

### Android (APK)

```bash
npm run android:apk
```

This builds the web app, syncs it into the native project, and runs Gradle. The APK is written to:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

The Gradle wrapper needs to find your Android SDK. Set `ANDROID_HOME`, or create `android/local.properties` containing a line like `sdk.dir=/path/to/Android/sdk`. Android Studio creates that file automatically if you open the project once with `npm run android:open`.

Put the APK on your phone in one of these ways:

- **USB:** enable *Developer options → USB debugging*, then run `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.
- **Copy the file:** use a cable, cloud drive or email, then tap the APK on the phone and allow "Install unknown apps" for the app you opened it with.
- **Android Studio:** run `npm run android:open` and press ▶ with your phone connected.

**No Android SDK on your computer?** Every push to GitHub runs the *Build* workflow (`.github/workflows/build.yml`), which builds the APK. Open the repository's **Actions** tab, select the latest run, and download the **tab-transcribe-android-apk** artifact.

#### Signed release build (optional)

The debug APK is fine for your own phones. To make a signed release APK, for example to share it or to publish it:

```bash
keytool -genkey -v -keystore android/release.keystore -alias tabtranscribe -keyalg RSA -keysize 2048 -validity 10000
```

Then create `android/keystore.properties` (it is git-ignored):

```properties
storeFile=release.keystore
storePassword=********
keyAlias=tabtranscribe
keyPassword=********
```

Finally, run `npm run android:release`. The output is `android/app/build/outputs/apk/release/app-release.apk`; use `./gradlew bundleRelease` in `android/` if you need an AAB for the Play Store.

### iPhone / iPad

```bash
npm run ios:open
```

In Xcode, select the **App** target. Under *Signing & Capabilities*, choose your team; a free Apple ID works for your own devices. Then select your connected device and press ▶.

### Desktop / browser

```bash
npm run dev        # development server with hot reload
npm run build      # production build in dist/
npm run preview    # serve the production build locally
```

The production build is a static site, so any static host works. Served over HTTPS, it is an installable PWA that also works offline: in Chrome or Edge, use *Install app* in the address bar.

---

## Using the app

1. Tap **Choose an audio or video file**: MP3, M4A/AAC, WAV, FLAC, Ogg/Opus, MP4, MOV, WebM or MKV. Anything the device can play will work.
2. (Optional) Open **Options** to override the defaults:
   - **Instrument**: auto-detect, guitar only, bass only, or guitar + bass.
   - **Guitar/Bass tuning**: by default, standard tuning. The app decides only the number of strings: a 5-string bass (B E A D G) or 7-string guitar when there are low notes only the extra string can play. You can also pick a fixed tuning (4/5/6-string bass, 6/7-string guitar, drop D, E♭, D standard, drop C, DADGAD, open tunings) or let the app guess any tuning from the notes.
   - **Capo** for guitar. Frets are then shown relative to the capo.
   - **Note sensitivity**: *Low* keeps only clear notes; *High* also picks up quiet ghost notes.
   - **Tempo**, **time signature** and **rhythm grid** (16ths or triplets). All default to automatic.
   - **Processing**: GPU (WebGL) or CPU (WebAssembly). *Auto* uses the GPU only if it gives exactly the same results as the CPU.
3. Tap **Transcribe**. On CPU, a 3-minute song takes about 20–40 seconds on a typical computer and longer on a phone. The GPU is usually faster.
4. Review the result:
   - The chips at the top show which instruments were detected and how confident the app is, plus the tempo.
   - Switch between **Guitar / Bass / Both** tabs.
   - Press ▶ and listen to the **Original**, the **Transcription** (synthesised), or **Both** together to check the tab by ear.
   - Tap anywhere in the tab to jump to that position.
   - The **Piano roll** shows every note the model heard, coloured by the instrument it was assigned to. Grey notes were discarded as overtones or noise.
5. Changing options after a transcription updates the tab instantly; the recording is not re-analysed.
6. **Export** as `.txt`, `.mid` or `.musicxml`. On a phone, this opens the share sheet so you can save to Files/Drive or send the file to another app.

### Playthrough videos (camera on the fretboard)

If the video shows someone playing the bass or guitar, the footage can correct the tab:

1. Choose the video, tick **Playthrough video** and pick the **filmed instrument**.
2. In the frame that appears, drag the slider to a frame where the neck is clearly visible, ideally with the hand away from the frets you'll mark.
3. Tap two fret spaces you can identify, such as the inlays at frets 5 and 12, and set their fret numbers. A blue fret grid appears. It should sit on the fret wires, so drag a mark to adjust it. You can add a third mark for perspective. Frets are counted from the nut even when the nut is off screen.
4. Tap **Transcribe**.

The app then follows the neck through the video and finds where the fretting hand covers the fretboard. It uses that position in three ways:

- It places notes on the strings and frets under the hand, instead of wherever is easiest.
- It moves a note up or down an octave when the hand can't be playing it where it was heard. The note detector often gets bass notes an octave wrong. This only happens when the hand was clearly seen on the board. When the hand is out of view and only assumed to be near the nut, the note is kept and counts for less.
- It always shows a track for the filmed instrument.

While playing back, **Neck overlay** draws the tracked frets and the detected hand over the video, so you can check them.

This works best when:

- **Camera:** it doesn't zoom. The instrument may move and tilt.
- **Fretboard:** it is in view and contrasts with the hand. A light maple board and a dark hand, or a dark rosewood board and a light hand, both work.
- **Hand:** it moves around at least now and then. If it never leaves one spot, choose a calibration frame where that spot is uncovered.

The video tells the app where the hand is, not which finger presses which string. So it corrects positions and octave mistakes, but it can't recover notes the audio missed entirely.

### Tips and limitations

- Works best on recordings where the guitar and/or bass are clearly audible: practice videos, DI/amp recordings, band rehearsals, or isolated stems.
- The note model does not separate instruments. Vocals, keyboards or horns in a full mix will show up as extra "guitar" notes. Separating the stems first (for example with a stem-splitter) gives much cleaner tabs.
- Heavy distortion and very fast playing make note detection harder. Try *High* sensitivity for quiet parts or *Low* for noisy ones.
- The app does not detect techniques such as bends, slides, hammer-ons or palm muting; it writes the notes you hear.
- If a file's audio can't be decoded, the app says so, instead of reporting that no instruments were found. The browser's console (F12) shows which decoders were tried (`[decode]` lines). Converting the file to MP3 or WAV, or trying another browser, usually helps.
- Long files need a lot of memory while they are analysed (a few hundred MB for 10 minutes). On older phones, trim very long videos first.

---

## How it works

```
file ──► decode (Web Audio → MP4 demux + WebCodecs → media-element capture; silence = failure) ──► mono 22.05 kHz
     ──► [worker] Basic Pitch (TensorFlow.js, WebGL/WASM) ──► frame + onset activations
     ──► note decoding ──► onset refinement (spectral flux) ──► timbre features per note
     ──► fragment merging ──► instrument detection & assignment
     ──► bass: monophonic line · guitar: overtone removal
     ──► tuning auto-select ──► Viterbi fingering optimiser ──► beat tracking & quantisation
     ──► tab layout / MIDI / MusicXML
```

| Area | File | Approach |
| --- | --- | --- |
| Note detection | `src/engine/basicPitch.ts`, `src/engine/noteDecoding.ts` | Basic Pitch inference in batched windows, plus an O(n log n) port of its note decoder. |
| Onsets & timbre | `src/engine/features.ts` | Low notes are detected late by the model, so onsets snap to peaks of a spectral-flux envelope. Per-note harmonic analysis measures fundamental dominance and harmonic centroid. |
| Instrument detection | `src/music/instruments.ts` | Per-note bass-vs-guitar log-likelihood built from register, lowest-voice share, chord context and timbre. Presence is decided from the amount of confident evidence. The bass line is the maximum-weight monophonic subset (weighted interval scheduling). Overtone ghosts are recognised by interval, timing, relative strength and whether they stand alone. |
| Tuning | `src/music/tunings.ts` | A popularity prior, a fit to the fretboard range, and a bonus when the open low string is actually played. |
| Fingering | `src/music/fingering.ts` | Viterbi search over chord shapes and positions. It scores stretch, fingers and barres, fret height, open strings and muted inner strings, plus hand shifts (weighted by how fast they must happen), string skips and cutting off ringing strings. The hand is modelled as a range of index-finger positions, so open-position playing is understood. |
| Playthrough video | `src/vision/`, `src/music/playthrough.ts` | The fretboard is modelled from 2–3 marked fret spaces using the equal-tempered fret rule, with an optional perspective term. The neck is tracked by aligning every frame to the calibration frame with a robust similarity warp. It uses a coarse search and then pyramid Gauss-Newton with Tukey weights; the scale prior guards against the fretboard's self-similarity. Each frame's board is resampled into a strip. The uncovered board is the tightest cluster of each cell over time, falling back to the calibration frame. Covered stretches, after a local misalignment correction, give the hand's fret window. That window adds costs in the fingering search and drives octave corrections. Frames are captured by fast muted playback and analysed in a worker. |
| Rhythm | `src/music/rhythm.ts` | Autocorrelation tempo estimate with a log-normal prior, a dynamic-programming beat tracker (Ellis 2007), half-tempo correction, triplet detection, and downbeat choice from low-note accents. |

## Development

```bash
npm test             # unit tests (fingering, detection, rhythm, tab layout, exports, fretboard vision on synthetic footage)
npm run test:model   # runs the real neural model on synthesised guitar/bass recordings
npm run build && npm run test:e2e   # browser tests of the production build (audio + video input)
npm run icons        # regenerate PNG icons/splash screens from public/icons/icon.svg
```

The model tests synthesise plucked-string recordings (Karplus-Strong) of a bass line, strummed chords, a melody, and mixtures of them. They check note accuracy, timing, instrument detection and fingering. The browser tests upload a WAV and a WebM video recorded in the browser, then check detection, the tab, tap-to-seek, playback and all three exports. They also film a synthetic bass playthrough: they calibrate it by tapping the inlays and check that the tab moves to where the filmed hand is. Screenshots are saved to `tests/e2e/out/`.

## Third-party components

- **Basic Pitch** model (`public/models/basic-pitch/`) © Spotify AB, Apache License 2.0 (see `public/models/basic-pitch/LICENSE`). The inference and note-decoding code in `src/engine/` is adapted from basic-pitch-ts under the same licence.
- [TensorFlow.js](https://github.com/tensorflow/tfjs) (Apache 2.0) and [Capacitor](https://capacitorjs.com) (MIT).
