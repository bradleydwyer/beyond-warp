import * as THREE from 'three';

// An original, deliberately small procedural stand-in for the Enterprise.
// No external model or texture downloads are needed.
export function createShip() {
  const ship = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0x74868c, metalness: .72, roughness: .38 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x293c46, metalness: .8, roughness: .4 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xa1b2b7, metalness: .6, roughness: .32 });
  const blue = new THREE.MeshBasicMaterial({ color: new THREE.Color(.18, 1.2, 2.4) });
  const dimBlue = new THREE.MeshBasicMaterial({ color: new THREE.Color(.08, .32, .65) });
  const warm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, .5, .17) });
  const windowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(.75, 1.0, 1.15) });

  function ellipsoid(position, scale, mat = hull, segments = 32) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, segments, 16), mat);
    mesh.position.set(...position); mesh.scale.set(...scale); ship.add(mesh); return mesh;
  }
  function strut(a, b, radius, mat = hull) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.25, start.distanceTo(end), 8), mat);
    mesh.position.copy(start).add(end).multiplyScalar(.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(start).normalize());
    ship.add(mesh); return mesh;
  }
  const saucerProfile = [[0,-.052],[.15,-.052],[.26,-.026],[.57,-.009],[.62,.014],[.61,.038],[.31,.068],[.18,.105],[0,.12]].map(p => new THREE.Vector2(...p));
  const saucer = new THREE.Mesh(new THREE.LatheGeometry(saucerProfile, 96), hull);
  saucer.position.set(-.49, .13, 0); ship.add(saucer);
  ellipsoid([-.5,.265,0],[.12,.045,.105],rim);
  for (const radius of [.24, .34, .47, .59]) {
    const line = new THREE.Mesh(new THREE.TorusGeometry(radius, .003, 4, 96), dark);
    line.rotation.x = Math.PI / 2; line.position.set(-.49,.193 - radius * .065,0); ship.add(line);
  }
  // Small radial seams make the saucer read as a manufactured object.
  const seams = [];
  for (let i=0; i<40; i++) {
    const a=i/40*Math.PI*2;
    seams.push(-.49+Math.cos(a)*.32,.173,Math.sin(a)*.32,-.49+Math.cos(a)*.58,.151,Math.sin(a)*.58);
  }
  const seamGeo=new THREE.BufferGeometry(); seamGeo.setAttribute('position',new THREE.Float32BufferAttribute(seams,3));
  ship.add(new THREE.LineSegments(seamGeo,new THREE.LineBasicMaterial({color:0x3f535f,transparent:true,opacity:.45})));
  ellipsoid([.24,-.17,0],[.58,.13,.15]);
  ellipsoid([-.30,-.17,0],[.018,.078,.09],dimBlue);
  strut([-.32,.11,0],[.12,-.17,0],.07);
  for (const s of [-1,1]) {
    strut([.24,-.16,s*.08],[.55,.15,s*.46],.035);
    ellipsoid([.53,.17,s*.50],[.60,.075,.085],rim);
    ellipsoid([.58,.183,s*.569],[.43,.025,.012],blue);
    ellipsoid([-.04,.17,s*.50],[.05,.055,.065],dimBlue);
    ellipsoid([1.09,.17,s*.50],[.026,.048,.055],blue);
  }
  const windowGeo = new THREE.SphereGeometry(.006, 4, 4);
  for (let i=0; i<62; i++) {
    const a=i/62*Math.PI*2;
    if (i%7===0) continue;
    const m=new THREE.Mesh(windowGeo,windowMat);
    m.position.set(-.49+Math.cos(a)*.609,.152,Math.sin(a)*.609); ship.add(m);
  }
  ellipsoid([-.49,.16,.622],[.009,.008,.008],warm,8);
  ellipsoid([-.49,.16,-.622],[.009,.008,.008],blue,8);
  ship.scale.setScalar(.72);
  ship.position.set(5,0,0);
  return ship;
}
