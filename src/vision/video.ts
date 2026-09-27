/** Reads grayscale frames from a video file by seeking a hidden video element. */
import { grayFromRgba, type GrayImage } from './image';

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|3gp)$/i.test(file.name);
}

/**
 * Browser recordings (MediaRecorder WebM) carry no duration, so `duration` is Infinity until the
 * browser has seen the end of the file: seeking far past the end makes it find out.
 */
async function resolveDuration(video: HTMLVideoElement): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      if (!Number.isFinite(video.duration)) return;
      clearTimeout(timer);
      video.removeEventListener('durationchange', done);
      video.removeEventListener('timeupdate', done);
      resolve();
    };
    const timer = setTimeout(() => {
      video.removeEventListener('durationchange', done);
      video.removeEventListener('timeupdate', done);
      resolve();
    }, 5000);
    video.addEventListener('durationchange', done);
    video.addEventListener('timeupdate', done);
    video.currentTime = 1e7;
  });
  video.currentTime = 0;
}

export class VideoFrames {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly url: string,
    /** Size of the frames handed out (analysis resolution). */
    readonly width: number,
    readonly height: number,
    private readonly fallbackDuration: number,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  /**
   * Open `file`; frames are scaled so that their width is `width` pixels. `fallbackDuration` is
   * used if the file doesn't say how long it is (e.g. the length of its decoded audio).
   */
  static async open(file: Blob, width = 360, fallbackDuration = 0): Promise<VideoFrames> {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    video.src = url;
    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('This video could not be opened in this browser.'));
      });
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    if (!video.videoWidth || !video.videoHeight) {
      URL.revokeObjectURL(url);
      throw new Error('This file has no video picture.');
    }
    if (!Number.isFinite(video.duration)) await resolveDuration(video);
    const w = Math.min(width, video.videoWidth);
    return new VideoFrames(video, url, w, Math.round((video.videoHeight * w) / video.videoWidth), fallbackDuration);
  }

  get duration(): number {
    return Number.isFinite(this.video.duration) && this.video.duration > 0 ? this.video.duration : this.fallbackDuration;
  }

  get aspect(): number {
    return this.video.videoWidth / this.video.videoHeight;
  }

  private async seek(time: number): Promise<void> {
    const t = Math.max(0, Math.min(time, Math.max(0, this.duration - 0.01)));
    if (Math.abs(this.video.currentTime - t) < 1e-3 && this.video.readyState >= 2) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.video.removeEventListener('seeked', done);
        resolve();
      };
      const timer = setTimeout(done, 3000);
      this.video.addEventListener('seeked', done);
      this.video.currentTime = t;
    });
  }

  /** Draw the frame at `time` into `target` (any size), e.g. for the calibration view. */
  async drawAt(time: number, target: CanvasRenderingContext2D, w: number, h: number): Promise<void> {
    await this.seek(time);
    target.drawImage(this.video, 0, 0, w, h);
  }

  /** Grayscale frame at `time`, at analysis resolution. */
  async grayAt(time: number): Promise<GrayImage> {
    await this.seek(time);
    this.ctx.drawImage(this.video, 0, 0, this.width, this.height);
    const { data } = this.ctx.getImageData(0, 0, this.width, this.height);
    return grayFromRgba(data, this.width, this.height);
  }

  private snapshot(): Promise<ImageBitmap> {
    return createImageBitmap(this.video, { resizeWidth: this.width, resizeHeight: this.height, resizeQuality: 'medium' });
  }

  /**
   * Hand out a frame (scaled to the analysis size) about every 1/fps seconds of video, in time
   * order. The video plays muted at a few times normal speed and frames are taken as they are
   * shown, which is much faster than seeking to each one; playback pauses while `backlog()`
   * (frames still being processed) is high. Seeks instead where frame callbacks aren't
   * available, or if playback stalls, and afterwards for any stretch playback skipped (frames
   * can then arrive out of time order).
   */
  async capture(
    fps: number,
    onFrame: (time: number, bitmap: ImageBitmap) => void,
    backlog: () => number,
    onProgress: (fraction: number) => void,
  ): Promise<void> {
    const v = this.video;
    const duration = this.duration;
    const step = 1 / fps;
    let next = 0;
    const taken: number[] = [];
    const deliver = (t: number, bitmap: ImageBitmap) => {
      taken.push(t);
      onFrame(t, bitmap);
    };
    const waitForBacklog = async () => {
      while (backlog() > 2) await new Promise((r) => setTimeout(r, 15));
    };
    if ('requestVideoFrameCallback' in v && duration > 0) {
      await this.seek(0);
      let lastFrame = performance.now();
      let holding = false;
      const stalled = await new Promise<boolean>((resolve, reject) => {
        let done = false;
        const finish = (stall: boolean) => {
          if (done) return;
          done = true;
          clearInterval(watchdog);
          v.onended = null;
          v.pause();
          resolve(stall);
        };
        const onVideoFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
          if (done) return;
          lastFrame = performance.now();
          const t = meta.mediaTime;
          if (t + 1e-3 >= next) {
            next = Math.max(next + step, t + step / 2);
            const shot = this.snapshot();
            shot.then((bitmap) => deliver(t, bitmap), reject);
            onProgress(Math.min(1, t / duration));
            if (backlog() > 5 && !holding) {
              holding = true;
              v.pause();
              void waitForBacklog().then(() => {
                holding = false;
                if (!done) void v.play().catch(reject);
              });
            }
          }
          v.requestVideoFrameCallback(onVideoFrame);
        };
        const watchdog = setInterval(() => {
          if (!holding && !v.paused && performance.now() - lastFrame > 3000) finish(true);
        }, 500);
        v.onended = () => finish(false);
        v.requestVideoFrameCallback(onVideoFrame);
        v.playbackRate = 3;
        v.play().catch(() => finish(true));
      });
      if (stalled) next = Math.max(0, ...taken, 0) + step;
      else next = duration;
    }
    // Seek to each remaining frame, then to any stretch playback skipped.
    for (let t = next; t < duration; t += step) {
      await waitForBacklog();
      await this.seek(t);
      deliver(t, await this.snapshot());
      onProgress(t / duration);
    }
    const sorted = [...taken].sort((a, b) => a - b);
    const bounds = [-step, ...sorted, duration];
    for (let i = 1; i < bounds.length; i++) {
      for (let t = bounds[i - 1] + step; t < bounds[i] - step / 2; t += step) {
        await waitForBacklog();
        await this.seek(t);
        deliver(t, await this.snapshot());
      }
    }
  }

  close(): void {
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}
