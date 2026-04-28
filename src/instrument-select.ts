import {
  createComponent,
  createSystem,
  Entity,
  Pressed,
  RayInteractable,
  Transform,
} from "@iwsdk/core";

/** Marker component added to all instrument entities. */
export const InstrumentTag = createComponent('InstrumentTag', {});

export class InstrumentSelectSystem extends createSystem({
  /** All instruments — needed to deselect others. */
  instruments: { required: [InstrumentTag, RayInteractable] },
  /** Instruments that are currently being pressed (ray + pinch/trigger). */
  pressed: { required: [InstrumentTag, RayInteractable, Pressed] },
}) {
  /** The single currently-selected entity, or null. */
  private selectedEntity: Entity | null = null;

  private setScale(entity: Entity, s: number) {
    const scale = entity.getVectorView(Transform, 'scale') as Float32Array;
    scale[0] = s; scale[1] = s; scale[2] = s;
  }

  init() {
    this.queries.pressed.subscribe('qualify', (entity) => {
      if (this.selectedEntity?.index === entity.index) {
        // Pressing the already-selected instrument — deselect it
        this.setScale(entity, 1);
        this.selectedEntity = null;
      } else {
        // Deselect the previous selection
        if (this.selectedEntity !== null) {
          this.setScale(this.selectedEntity, 1);
        }
        // Select the new one
        this.selectedEntity = entity;
        this.setScale(entity, 2);
      }
    });
  }
}
