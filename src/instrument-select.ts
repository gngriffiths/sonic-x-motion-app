import {
  createComponent,
  createSystem,
  Pressed,
  RayInteractable,
  Transform,
} from "@iwsdk/core";

/** Marker component added to all instrument entities. */
export const InstrumentTag = createComponent('InstrumentTag', {});

export class InstrumentSelectSystem extends createSystem({
  /** Instruments that are currently being pressed (ray + pinch/trigger). */
  pressed: { required: [InstrumentTag, RayInteractable, Pressed] },
}) {
  /** Tracks which entity indices are currently scaled up. */
  private readonly selected = new Set<number>();

  init() {
    // qualify fires once when the press starts — use it as the "click" moment
    this.queries.pressed.subscribe('qualify', (entity) => {
      const scale = entity.getVectorView(Transform, 'scale') as Float32Array;
      if (this.selected.has(entity.index)) {
        // Already selected — deselect and restore scale
        this.selected.delete(entity.index);
        scale[0] = 1; scale[1] = 1; scale[2] = 1;
      } else {
        // Select — scale up 2x
        this.selected.add(entity.index);
        scale[0] = 2; scale[1] = 2; scale[2] = 2;
      }
    });
  }
}
