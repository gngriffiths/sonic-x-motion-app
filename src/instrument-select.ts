import {
  createComponent,
  createSystem,
  Entity,
  Pressed,
  RayInteractable,
  Transform,
  Types,
} from "@iwsdk/core";

/** drums=0, bass=1, keyboard=2 — matches Ableton track index (0-based). */
export const InstrumentTag = createComponent('InstrumentTag', {
  trackIndex: { type: Types.Int32, default: 0 },
});

/** Tag present on the currently selected instrument entity. */
export const InstrumentSelected = createComponent('InstrumentSelected', {});

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
        entity.removeComponent(InstrumentSelected);
        this.selectedEntity = null;
      } else {
        // Deselect the previous selection
        if (this.selectedEntity !== null) {
          this.setScale(this.selectedEntity, 1);
          this.selectedEntity.removeComponent(InstrumentSelected);
        }
        // Select the new one
        this.selectedEntity = entity;
        this.setScale(entity, 2);
        entity.addComponent(InstrumentSelected);
      }
    });
  }
}
