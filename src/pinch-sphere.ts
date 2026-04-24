import {
  createSystem,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from "@iwsdk/core";

export class PinchSphereSystem extends createSystem({}) {
  private leftSphere!: Mesh;
  private rightSphere!: Mesh;
  private pos!: Vector3;

  init() {
    this.pos = new Vector3();

    const geo = new SphereGeometry(0.015, 16, 16);
    const mat = new MeshStandardMaterial({
      color: 0xff7700,
      roughness: 0.3,
      metalness: 0.1,
    });

    this.leftSphere = new Mesh(geo, mat);
    this.leftSphere.visible = false;
    this.world.createTransformEntity(this.leftSphere, {
      parent: this.world.sceneEntity,
      persistent: true,
    });

    this.rightSphere = new Mesh(geo, mat);
    this.rightSphere.visible = false;
    this.world.createTransformEntity(this.rightSphere, {
      parent: this.world.sceneEntity,
      persistent: true,
    });
  }

  update() {
    const leftGamepad = this.input.gamepads.left;
    if (leftGamepad?.getSelecting()) {
      this.player.indexTipSpaces.left.getWorldPosition(this.pos);
      this.leftSphere.position.copy(this.pos);
      this.leftSphere.visible = true;
    } else {
      this.leftSphere.visible = false;
    }

    const rightGamepad = this.input.gamepads.right;
    if (rightGamepad?.getSelecting()) {
      this.player.indexTipSpaces.right.getWorldPosition(this.pos);
      this.rightSphere.position.copy(this.pos);
      this.rightSphere.visible = true;
    } else {
      this.rightSphere.visible = false;
    }
  }
}
