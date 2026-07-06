declare module 'perfect-freehand' {
  export interface StrokePoint {
    x: number;
    y: number;
    pressure?: number;
  }
  export interface StrokeOptions {
    size?: number;
    thinning?: number;
    smoothing?: number;
    streamline?: number;
    simulatePressure?: boolean;
    easing?: (t: number) => number;
    last?: boolean;
    start?: { cap?: boolean; taper?: number | boolean; easing?: (t: number) => number };
    end?: { cap?: boolean; taper?: number | boolean; easing?: (t: number) => number };
  }
  export function getStroke(
    points: (number[] | StrokePoint)[],
    options?: StrokeOptions,
  ): [number, number][];
}