// Minimal ambient declaration for gifenc 1.0.3.
//
// gifenc ships only a JavaScript dist (no bundled .d.ts) and no `@types/gifenc`
// package exists on npm at time of writing. The canonical reference is
// gifenc's own source (see the GitHub link at the bottom of this file).
//
// We declare TWO module paths because Node and Vite resolve gifenc via
// different fields in its package.json (it has no `"exports"` map):
//  - `gifenc` — the bare specifier. Resolves via "main" (CJS) under Node
//    production, via "module" (ESM) under Vite/Vitest.
//  - `gifenc/dist/gifenc.esm.js` — the ESM build by explicit deep path.
//    The renderer imports this form so both runtimes load the ESM build
//    (whose named exports are stable); this declaration makes TS happy.
//
// Reference: https://github.com/mattdesl/gifenc/blob/master/src/index.js

declare module 'gifenc' {
  export type RGB = [number, number, number] | readonly [number, number, number];
  export type Palette = readonly RGB[];

  export interface GifFrameOptions {
    /** Caller-supplied palette (palette-mode encoding — no auto-quantization). Required on the first frame; writes the Global Color Table. */
    palette?: Palette;
    /** 0 = loop forever (writes NETSCAPE2.0 loop block). Negative = no loop block. */
    repeat?: number;
    /** Frame delay in MILLISECONDS (gifenc converts to centiseconds internally). */
    delay?: number;
    /** If true, marks the frame as transparent via the GCE transparent flag. */
    transparent?: boolean;
    /** The palette slot index to use as the transparent color. */
    transparentIndex?: number;
    /** GIF disposal method (0-7). Pass `3` for DISPOSAL_PREVIOUS. Masked via `dispose & 7` in the GCE byte. */
    dispose?: number;
    /** Optional first color index (rarely needed). */
    first?: boolean;
  }

  export interface GIFEncoderInstance {
    /**
     * Writes a single frame. `index` is a Uint8Array of palette slot indices
     * (NOT RGBA bytes) — length must equal `width * height`.
     */
    writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
    /** Finalizes the GIF stream (writes the trailer byte). */
    finish(): void;
    /** Returns the finished GIF byte stream. Valid only after `finish()`. */
    bytes(): Uint8Array;
    /** Returns the current byte length of the stream (mid-encoding). */
    bytesView(): Uint8Array;
    /** Resets the encoder for reuse (rarely needed). */
    reset(): void;
  }

  /** Creates a new GIF encoder instance. */
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GIFEncoderInstance;

  /** Optional quantizer — NOT used by the countdown renderer (we supply our own palette). */
  export function quantize(rgba: Uint8Array, maxColors: number, options?: unknown): Palette;

  /** Optional nearest-color index lookup — NOT used by the countdown renderer (it runs its own per-pixel loop). */
  export function applyPalette(rgba: Uint8Array, palette: Palette, format?: string): Uint8Array;
}

declare module 'gifenc/dist/gifenc.esm.js' {
  export type RGB = [number, number, number] | readonly [number, number, number];
  export type Palette = readonly RGB[];
  export interface GifFrameOptions {
    palette?: Palette;
    repeat?: number;
    delay?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
    first?: boolean;
  }
  export interface GIFEncoderInstance {
    writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }
  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): GIFEncoderInstance;
}
