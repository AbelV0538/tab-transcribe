# Tab Transcribe

Turn a recording or video of **guitar and/or bass** into **playable tablature**.

Pick an audio or video file. The app:

1. **Separates the instruments** into guitar and bass stems with Meta's [HTDemucs](https://github.com/facebookresearch/demucs), so vocals, keys and drums can't turn into wrong notes. This runs on the device: on by default on computers, optional on phones.
2. **Listens for notes** with Spotify's [Basic Pitch](https://github.com/spotify/basic-pitch), a lightweight polyphonic neural transcription model that runs on the device.
3. **Detects which instrument is playing** (guitar, bass, or both) and splits the notes between them.
4. **Chooses the most likely, playable interpretation**:
   - removes overtone "ghost" notes and duplicate detections;
   - keeps the bass line monophonic;
   - picks the tuning (standard, drop D, E♭, 5-string bass, …);
   - finds the most natural fingering on the fretboard;
   - tracks the beat and snaps notes to a 16th-note or triplet grid.
5. Shows the result as **tab**, with a cursor that follows playback of the original, the isolated guitar or bass stem, or a synthesised rendering of the transcription (at 50%, 75% or 100% speed).
6. **Exports** the result as a plain-text tab (`.txt`), a MIDI file (`.mid`), or MusicXML with tablature (`.musicxml`). MusicXML opens in MuseScore, Guitar Pro, TuxGuitar, Sibelius and similar apps.

Everything runs locally: recordings are never uploaded. The only download is the instrument-separation model, fetched once the first time it's needed.

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
   - **Separate instruments first**: splits the recording into guitar and bass stems before listening for notes (see *Instrument separation* below). *Auto* does this on computers but not on phones, where it is slow; *On* and *Off* force it.
   - **Instrument**: auto-detect, guitar only, bass only, or guitar + bass.
   - **Guitar/Bass tuning**: by default, standard tuning. The app decides only the number of strings: a 5-string bass (B E A D G) or 7-string guitar when there are low notes only the extra string can play. You can also pick a fixed tuning (4/5/6-string bass; 6-, 7- and 8-string guitar; drop D, E♭, D standard, C♯ standard, drop C, 7-string drop A and A standard, 8-string drop E and drop E♭, DADGAD, open tunings) or let the app guess any tuning from the notes.
   - **Capo** for guitar. Frets are then shown relative to the capo.
   - **Note sensitivity**: *Low* keeps only clear notes; *High* also picks up quiet ghost notes.
   - **Tempo**, **time signature** and **rhythm grid** (16ths or triplets). All default to automatic.
   - **Processing**: GPU (WebGL) or CPU (WebAssembly). *Auto* uses the GPU only if it gives exactly the same results as the CPU. *CPU* also keeps instrument separation off the GPU.
3. Tap **Transcribe**. Without instrument separation, a 3-minute song takes about 20–40 seconds on CPU on a typical computer and longer on a phone. The GPU is usually faster. Separation adds to this (see below).
4. Review the result:
   - The chips at the top show which instruments were detected and how confident the app is, plus the tempo, and whether the instruments were separated first.
   - Switch between **Guitar / Bass / Both** tabs.
   - Press ▶ and listen to the **Original**, the **Transcription** (synthesised), or **Both** together to check the tab by ear. After instrument separation you can also listen to the isolated **Guitar stem** or **Bass stem**.
   - Tap anywhere in the tab to jump to that position.
   - The **Piano roll** shows every note the model heard, coloured by the instrument it was assigned to. Grey notes were discarded as overtones or noise.
5. Changing options after a transcription updates the tab instantly; the recording is not re-analysed. *Separate instruments first* is the exception: it applies the next time you tap **Transcribe**.
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

### Instrument separation

On its own, the note model hears everything in a recording. In a full band mix, vocals, keyboards, horns and drum hits show up as extra "guitar" notes, and guitar and bass have to be told apart by register and sound alone. With **Separate instruments first**, the app first splits the recording into stems with HTDemucs (6-stem version: drums, bass, other, vocals, guitar, piano). It then listens to the guitar stem and the bass stem separately. Only those two stems are transcribed, and each note carries the stem it was heard in as strong evidence for its instrument.

- **Download:** the first time, the app downloads the model (136 MB) from a fixed revision on Hugging Face, checks its SHA-256 checksum, and keeps it in the browser's storage, so later runs (also offline) don't download it again. Your recordings are not uploaded.
- **Speed:** this depends almost entirely on the GPU. Measured on a Core Ultra 9 laptop with a 3¼-minute song:
  - On its RTX 4070 Laptop GPU (WebGPU), separation takes about 50 seconds, 15 of them to load the model, and the whole transcription about 75 seconds.
  - On its integrated GPU, or on the CPU (WebAssembly, one thread), separation takes about 2 seconds per second of music, so 7–8 minutes. On a phone it's longer still.

  The progress bar shows the estimated time left.
- **Which GPU:** Windows decides which GPU Chrome and Edge use, and on laptops with two GPUs that is usually the integrated one. To use the dedicated GPU, set the browser to *High performance* in *Settings → System → Display → Graphics*, then restart it.
- **Memory:** about 1.2 GB of RAM on the CPU, independent of the length of the recording, because the model works on 7.8-second pieces. On the RTX 4070, GPU memory peaked at 3.7 GB of 8 GB, a figure that includes note detection, which then also runs on that GPU. It runs in its own worker, which is closed afterwards to give the memory back before note detection starts, so the two never need memory at the same time.
- **When something goes wrong:** if the GPU fails or runs out of memory, the app redoes the separation on the CPU. If that fails too, or the model can't be downloaded, it transcribes the full mix as before and says so in the summary.
- **Listening:** after separation you can play the isolated **Guitar stem** or **Bass stem** in sync with the tab.

### Tips and limitations

- Works best on recordings where the guitar and/or bass are clearly audible: practice videos, DI/amp recordings, band rehearsals, or isolated stems.
- Instrument separation removes most of the other instruments, but not all: clean or heavily effected guitar can partly end up outside the guitar stem, and some bleed remains. Without separation (*Off*, or on phones with *Auto*), vocals, keyboards or horns in a full mix show up as extra "guitar" notes.
- Heavy distortion and very fast playing make note detection harder. Try *High* sensitivity for quiet parts or *Low* for noisy ones.
- The app does not detect techniques such as bends, slides, hammer-ons or palm muting; it writes the notes you hear.
- If a file's audio can't be decoded, the app says so, instead of reporting that no instruments were found. The browser's console (F12) shows which decoders were tried (`[decode]` lines). Converting the file to MP3 or WAV, or trying another browser, usually helps.
- Long files need a lot of memory while they are analysed (a few hundred MB for 10 minutes, plus about 1.1 GB during instrument separation). On older phones, trim very long videos first.

---

## How it works

```
file ──► decode (Web Audio → MP4 demux + WebCodecs → media-element capture; silence = failure) ──► mono 22.05 kHz
     ──► (separation on) stereo 44.1 kHz ──► [own worker] HTDemucs (ONNX Runtime Web, WebGPU → WASM)
         ──► guitar + bass stems, mono 22.05 kHz (other stems discarded)
     ──► [worker] Basic Pitch per source (the mix, or each stem) (TensorFlow.js, WebGL/WASM) ──► frame + onset activations
     ──► note decoding ──► onset refinement (spectral flux of the source) ──► timbre features per note, tagged with its stem
     ──► fragment merging ──► instrument detection & assignment
     ──► bass: monophonic line · guitar: overtone removal
     ──► tuning auto-select ──► Viterbi fingering optimiser ──► beat tracking & quantisation
     ──► tab layout / MIDI / MusicXML
```

| Area | File | Approach |
| --- | --- | --- |
| Instrument separation | `src/separation/` | HTDemucs 6-stem as ONNX, run by ONNX Runtime Web in a worker of its own that is closed afterwards (a WebAssembly heap never shrinks). As in Demucs itself, the mix is normalised by its mono mean and standard deviation, cut into 7.8 s segments with 25% overlap, and cross-faded with Demucs' triangular weights. Only the wanted stems are accumulated, as mono, and then decimated to 22.05 kHz with a Kaiser-windowed FIR. Graph optimisation is disabled because constant-folding the fp16 weight casts needs more than the 4 GB a WebAssembly heap can have. The JSEP build of ONNX Runtime is used, because the newer native-WebGPU build lacks a kernel the model's iSTFT needs. The note model hears quiet audio as well as loud, so every note gets a *stem share*: the amplitude of its harmonics in its stem relative to the mix. Notes that are only faint leftovers in a stem are dropped. When the guitar stem is nearly empty (the separator didn't recognise the guitar), the guitar, other and piano stems are transcribed together. |
| Note detection | `src/engine/basicPitch.ts`, `src/engine/noteDecoding.ts` | Basic Pitch inference in batched windows, plus an O(n log n) port of its note decoder. With separation, it runs once per stem; tempo and beats still come from the full mix, where the drums are. |
| Onsets & timbre | `src/engine/features.ts` | Low notes are detected late by the model, so onsets snap to peaks of a spectral-flux envelope. Per-note harmonic analysis measures fundamental dominance and harmonic centroid. |
| Instrument detection | `src/music/instruments.ts` | Per-note bass-vs-guitar log-likelihood built from register, lowest-voice share, chord context and timbre, plus the stem the note was heard in after separation. With stems, chord context, lowest voice and overtones are judged within each stem. Presence is decided from the amount of confident evidence. The bass line is the maximum-weight monophonic subset (weighted interval scheduling). Overtone ghosts are recognised by interval, timing, relative strength and whether they stand alone. |
| Tuning | `src/music/tunings.ts` | A popularity prior, a fit to the fretboard range, and a bonus when the open low string is actually played. |
| Fingering | `src/music/fingering.ts` | Viterbi search over chord shapes and positions. It scores stretch, fingers and barres, fret height, open strings and muted inner strings, plus hand shifts (weighted by distance and by how fast they must happen), string skips, cutting off ringing strings, and changing string in scale runs and fast legato (hammer-ons, pull-offs, slides and grace notes stay on one string). The hand is modelled as a range of index-finger positions, so open-position playing is understood. A weak note that would force a jump across the neck can be left out (it is usually another instrument or an overtone); it then shows grey in the piano roll. The guitar weights are fitted to professional tabs (see *Album benchmark* below). |
| Playthrough video | `src/vision/`, `src/music/playthrough.ts` | The fretboard is modelled from 2–3 marked fret spaces using the equal-tempered fret rule, with an optional perspective term. The neck is tracked by aligning every frame to the calibration frame with a robust similarity warp. It uses a coarse search and then pyramid Gauss-Newton with Tukey weights; the scale prior guards against the fretboard's self-similarity. Each frame's board is resampled into a strip. The uncovered board is the tightest cluster of each cell over time, falling back to the calibration frame. Covered stretches, after a local misalignment correction, give the hand's fret window. That window adds costs in the fingering search and drives octave corrections. Frames are captured by fast muted playback and analysed in a worker. |
| Rhythm | `src/music/rhythm.ts` | Autocorrelation tempo estimate with a log-normal prior, a dynamic-programming beat tracker (Ellis 2007), half-tempo correction, triplet detection, and downbeat choice from low-note accents. |

## Development

```bash
npm test             # unit tests (fingering, detection, rhythm, tab layout, exports, fretboard vision on synthetic footage)
npm run test:model   # runs the real neural model on synthesised guitar/bass recordings
npm run build && npm run test:e2e   # browser tests of the production build (audio + video input)
npm run test:album   # benchmark against professional tabs and recordings (see below; files not included)
npm run models:separation   # download the separation model to models/ for the Node and browser tests (136 MB)
npm run icons        # regenerate PNG icons/splash screens from public/icons/icon.svg
```

Tests that need the separation model skip without it, CI included. In development, `VITE_SEPARATION_MODEL_URL` points the app at another copy of the model, and `?debug=fail-gpu-separation` makes the GPU separation fail, to try the fallbacks.

The model tests synthesise plucked-string recordings (Karplus-Strong) of a bass line, strummed chords, a melody, and mixtures of them. They check note accuracy, timing, instrument detection and fingering. The browser tests upload a WAV and a WebM video recorded in the browser, then check detection, the tab, tap-to-seek, playback and all three exports. They also film a synthetic bass playthrough: they calibrate it by tapping the inlays and check that the tab moves to where the filmed hand is. Screenshots are saved to `tests/e2e/out/`. Without Playwright's own Chromium, point `CHROMIUM_PATH` at an installed Chrome.

### Album benchmark

`npm run test:album` measures the transcriber against professional tabs. It needs recordings and Guitar Pro 7+ (`.gp`) tabs of the same songs, which are copyrighted and therefore git-ignored:

```
RTYWD Audio/<Title>[ (feat. …)].mp3
RTYWD Guitar Tabs/[<n>] <Title>/…/<anything>.gp
```

Each benchmark skips when its files are missing.

- **Oracle fingering** (`tests/fingering.album.test.ts`, seconds): gives the fingering optimiser the tab's own notes and tuning, and compares the strings and frets it chooses with the tab's. It also reports playability: hand shifts, fast jumps across the neck, over-stretched shapes, mean fret and open strings.
- **End to end** (`tests/audio.album.test.ts`, needs `ffmpeg`): decodes each recording, runs the note model and `interpret()`, aligns the tab to the recording, and scores the guitar track's notes and frets against the union of the tab's guitar tracks. The model's output is cached in `.album-cache/`, so only the first run takes minutes. With the separation model in `models/`, every song is also transcribed from its separated stems (*separated* configurations, compared with the full mix song by song). The stems are cached in `.album-cache/stems/`, and separating the album once takes about 12 minutes on a desktop CPU. `ALBUM_SEPARATION_SWEEP=1` also compares which stems count as guitar (`GUITAR_STEMS`) and how strongly the stem decides the instrument (`STEM_PRIOR`).
- **Fitting** (`ALBUM_TUNE=1 npm run test:album`, about an hour): refits the guitar fingering weights by coordinate descent with 3-fold cross-validation by song. Weight sets that break the open-position expectations of `tests/fingering.test.ts` are rejected. It also sweeps the note-drop cost. Copy the printed weights into `GUITAR_WEIGHTS`.

Reports go to `tests/e2e/out/album-*.md`. Run with `ALBUM_BASELINE=1` once to save a baseline; later reports show changes against it.

Results of instrument separation on this benchmark (11 songs, default settings):

- Guitar F1 rose from 19.3% to 30.0%, better on every song. Precision went from 28.3% to 34.6% and recall from 15.1% to 27.6%.
- With the tab's tuning, fret agreement on the same 10 songs rose from 37.1% to 43.1%.
- Tempo detection was unchanged.
- In the sweep, transcribing "other" as guitar too lowered F1 (28.1% vs 29.6%). The stem-share threshold works best around 0.05–0.1. The stem prior matters little between 3.5 and 6.

## Third-party components

- **Basic Pitch** model (`public/models/basic-pitch/`) © Spotify AB, Apache License 2.0 (see `public/models/basic-pitch/LICENSE`). The inference and note-decoding code in `src/engine/` is adapted from basic-pitch-ts under the same licence.
- **HTDemucs** ([Demucs v4](https://github.com/facebookresearch/demucs), Rouard, Massa & Défossez) © Meta Platforms, MIT License, in the ONNX export [StemSplitio/htdemucs-6s-onnx](https://huggingface.co/StemSplitio/htdemucs-6s-onnx) (MIT). It is downloaded at run time from a pinned revision and not distributed with the app.
- [TensorFlow.js](https://github.com/tensorflow/tfjs) (Apache 2.0), [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (MIT) and [Capacitor](https://capacitorjs.com) (MIT).
