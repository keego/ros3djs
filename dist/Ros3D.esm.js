/**
 * @author Russell Toris - rctoris@wpi.edu
 * @author David Gossow - dgossow@willowgarage.com
 */

const REVISION = '0.18.0';

// Marker types
const MARKER_ARROW = 0;
const MARKER_CUBE = 1;
const MARKER_SPHERE = 2;
const MARKER_CYLINDER = 3;
const MARKER_LINE_STRIP = 4;
const MARKER_LINE_LIST = 5;
const MARKER_CUBE_LIST = 6;
const MARKER_SPHERE_LIST = 7;
const MARKER_POINTS = 8;
const MARKER_TEXT_VIEW_FACING = 9;
const MARKER_MESH_RESOURCE = 10;
const MARKER_TRIANGLE_LIST = 11;

// Interactive marker feedback types
const INTERACTIVE_MARKER_KEEP_ALIVE = 0;
const INTERACTIVE_MARKER_POSE_UPDATE = 1;
const INTERACTIVE_MARKER_MENU_SELECT = 2;
const INTERACTIVE_MARKER_BUTTON_CLICK = 3;
const INTERACTIVE_MARKER_MOUSE_DOWN = 4;
const INTERACTIVE_MARKER_MOUSE_UP = 5;

// Interactive marker control types
const INTERACTIVE_MARKER_NONE = 0;
const INTERACTIVE_MARKER_MENU = 1;
const INTERACTIVE_MARKER_BUTTON = 2;
const INTERACTIVE_MARKER_MOVE_AXIS = 3;
const INTERACTIVE_MARKER_MOVE_PLANE = 4;
const INTERACTIVE_MARKER_ROTATE_AXIS = 5;
const INTERACTIVE_MARKER_MOVE_ROTATE = 6;

// Interactive marker rotation behavior
const INTERACTIVE_MARKER_INHERIT = 0;
const INTERACTIVE_MARKER_FIXED = 1;
const INTERACTIVE_MARKER_VIEW_FACING = 2;

/**
 * Create a THREE material based on the given RGBA values.
 *
 * @param r - the red value
 * @param g - the green value
 * @param b - the blue value
 * @param a - the alpha value
 * @returns the THREE material
 */
const makeColorMaterial = function(r, g, b, a) {
  var color = new THREE.Color();
  color.setRGB(r, g, b);
  if (a <= 0.99) {
    return new THREE.MeshBasicMaterial({
      color : color.getHex(),
      opacity : a + 0.1,
      transparent : true,
      depthWrite : true,
      blendSrc : THREE.SrcAlphaFactor,
      blendDst : THREE.OneMinusSrcAlphaFactor,
      blendEquation : THREE.ReverseSubtractEquation,
      blending : THREE.NormalBlending
    });
  } else {
    return new THREE.MeshPhongMaterial({
      color : color.getHex(),
      opacity : a,
      blending : THREE.NormalBlending
    });
  }
};

/**
 * Return the intersection between the mouseray and the plane.
 *
 * @param mouseRay - the mouse ray
 * @param planeOrigin - the origin of the plane
 * @param planeNormal - the normal of the plane
 * @returns the intersection point
 */
const intersectPlane = function(mouseRay, planeOrigin, planeNormal) {
  var vector = new THREE.Vector3();
  var intersectPoint = new THREE.Vector3();
  vector.subVectors(planeOrigin, mouseRay.origin);
  var dot = mouseRay.direction.dot(planeNormal);

  // bail if ray and plane are parallel
  if (Math.abs(dot) < mouseRay.precision) {
    return undefined;
  }

  // calc distance to plane
  var scalar = planeNormal.dot(vector) / dot;

  intersectPoint.addVectors(mouseRay.origin, mouseRay.direction.clone().multiplyScalar(scalar));
  return intersectPoint;
};

/**
 * Find the closest point on targetRay to any point on mouseRay. Math taken from
 * http://paulbourke.net/geometry/lineline3d/
 *
 * @param targetRay - the target ray to use
 * @param mouseRay - the mouse ray
 * @param the closest point between the two rays
 */
const findClosestPoint = function(targetRay, mouseRay) {
  var v13 = new THREE.Vector3();
  v13.subVectors(targetRay.origin, mouseRay.origin);
  var v43 = mouseRay.direction.clone();
  var v21 = targetRay.direction.clone();
  var d1343 = v13.dot(v43);
  var d4321 = v43.dot(v21);
  var d1321 = v13.dot(v21);
  var d4343 = v43.dot(v43);
  var d2121 = v21.dot(v21);

  var denom = d2121 * d4343 - d4321 * d4321;
  // check within a delta
  if (Math.abs(denom) <= 0.0001) {
    return undefined;
  }
  var numer = d1343 * d4321 - d1321 * d4343;

  var mua = numer / denom;
  return mua;
};

/**
 * Find the closest point between the axis and the mouse.
 *
 * @param axisRay - the ray from the axis
 * @param camera - the camera to project from
 * @param mousePos - the mouse position
 * @returns the closest axis point
 */
const closestAxisPoint = function(axisRay, camera, mousePos) {
  // project axis onto screen
  var o = axisRay.origin.clone();
  o.project(camera);
  var o2 = axisRay.direction.clone().add(axisRay.origin);
  o2.project(camera);

  // d is the axis vector in screen space (d = o2-o)
  var d = o2.clone().sub(o);

  // t is the 2d ray param of perpendicular projection of mousePos onto o
  var tmp = new THREE.Vector2();
  // (t = (mousePos - o) * d / (d*d))
  var t = tmp.subVectors(mousePos, o).dot(d) / d.dot(d);

  // mp is the final 2d-projected mouse pos (mp = o + d*t)
  var mp = new THREE.Vector2();
  mp.addVectors(o, d.clone().multiplyScalar(t));

  // go back to 3d by shooting a ray
  var vector = new THREE.Vector3(mp.x, mp.y, 0.5);
  vector.unproject(camera);
  var mpRay = new THREE.Ray(camera.position, vector.sub(camera.position).normalize());

  return findClosestPoint(axisRay, mpRay);
};

/**
 * @author David Gossow - dgossow@willowgarage.com
 */

/**
 * The main interactive marker object.
 *
 * @constructor
 * @param options - object with following keys:
 *
 *  * handle - the ROS3D.InteractiveMarkerHandle for this marker
 *  * camera - the main camera associated with the viewer for this marker
 *  * path (optional) - the base path to any meshes that will be loaded
 *  * loader (optional) - the Collada loader to use (e.g., an instance of ROS3D.COLLADA_LOADER
 *                        ROS3D.COLLADA_LOADER_2) -- defaults to ROS3D.COLLADA_LOADER_2
 */
const InteractiveMarker = function(options) {
  THREE.Object3D.call(this);
  THREE.EventDispatcher.call(this);

  var that = this;
  options = options || {};
  var handle = options.handle;
  this.name = handle.name;
  var camera = options.camera;
  var path = options.path || '/';
  var loader = options.loader || ROS3D.COLLADA_LOADER_2;
  this.dragging = false;

  // set the initial pose
  this.onServerSetPose({
    pose : handle.pose
  });

  // information on where the drag started
  this.dragStart = {
    position : new THREE.Vector3(),
    orientation : new THREE.Quaternion(),
    positionWorld : new THREE.Vector3(),
    orientationWorld : new THREE.Quaternion(),
    event3d : {}
  };

  // add each control message
  handle.controls.forEach(function(controlMessage) {
    that.add(new ROS3D.InteractiveMarkerControl({
      parent : that,
      handle : handle,
      message : controlMessage,
      camera : camera,
      path : path,
      loader : loader
    }));
  });

  // check for any menus
  if (handle.menuEntries.length > 0) {
    this.menu = new ROS3D.InteractiveMarkerMenu({
      menuEntries : handle.menuEntries,
      menuFontSize : handle.menuFontSize
    });

    // forward menu select events
    this.menu.addEventListener('menu-select', function(event) {
      that.dispatchEvent(event);
    });
  }
};
InteractiveMarker.prototype.__proto__ = THREE.Object3D.prototype;

/**
 * Show the interactive marker menu associated with this marker.
 *
 * @param control - the control to use
 * @param event - the event that caused this
 */
InteractiveMarker.prototype.showMenu = function(control, event) {
  if (this.menu) {
    this.menu.show(control, event);
  }
};

/**
 * Move the axis based on the given event information.
 *
 * @param control - the control to use
 * @param origAxis - the origin of the axis
 * @param event3d - the event that caused this
 */
InteractiveMarker.prototype.moveAxis = function(control, origAxis, event3d) {
  if (this.dragging) {
    var currentControlOri = control.currentControlOri;
    var axis = origAxis.clone().applyQuaternion(currentControlOri);
    // get move axis in world coords
    var originWorld = this.dragStart.event3d.intersection.point;
    var axisWorld = axis.clone().applyQuaternion(this.dragStart.orientationWorld.clone());

    var axisRay = new THREE.Ray(originWorld, axisWorld);

    // find closest point to mouse on axis
    var t = ROS3D.closestAxisPoint(axisRay, event3d.camera, event3d.mousePos);

    // offset from drag start position
    var p = new THREE.Vector3();
    p.addVectors(this.dragStart.position, axis.clone().applyQuaternion(this.dragStart.orientation)
        .multiplyScalar(t));
    this.setPosition(control, p);


    event3d.stopPropagation();
  }
};

/**
 * Move with respect to the plane based on the contorl and event.
 *
 * @param control - the control to use
 * @param origNormal - the normal of the origin
 * @param event3d - the event that caused this
 */
InteractiveMarker.prototype.movePlane = function(control, origNormal, event3d) {
  if (this.dragging) {
    var currentControlOri = control.currentControlOri;
    var normal = origNormal.clone().applyQuaternion(currentControlOri);
    // get plane params in world coords
    var originWorld = this.dragStart.event3d.intersection.point;
    var normalWorld = normal.clone().applyQuaternion(this.dragStart.orientationWorld);

    // intersect mouse ray with plane
    var intersection = ROS3D.intersectPlane(event3d.mouseRay, originWorld, normalWorld);

    // offset from drag start position
    var p = new THREE.Vector3();
    p.subVectors(intersection, originWorld);
    p.add(this.dragStart.positionWorld);
    this.setPosition(control, p);
    event3d.stopPropagation();
  }
};

/**
 * Rotate based on the control and event given.
 *
 * @param control - the control to use
 * @param origOrientation - the orientation of the origin
 * @param event3d - the event that caused this
 */
InteractiveMarker.prototype.rotateAxis = function(control, origOrientation, event3d) {
  if (this.dragging) {
    control.updateMatrixWorld();

    var currentControlOri = control.currentControlOri;
    var orientation = currentControlOri.clone().multiply(origOrientation.clone());

    var normal = (new THREE.Vector3(1, 0, 0)).applyQuaternion(orientation);

    // get plane params in world coords
    var originWorld = this.dragStart.event3d.intersection.point;
    var normalWorld = normal.applyQuaternion(this.dragStart.orientationWorld);

    // intersect mouse ray with plane
    var intersection = ROS3D.intersectPlane(event3d.mouseRay, originWorld, normalWorld);

    // offset local origin to lie on intersection plane
    var normalRay = new THREE.Ray(this.dragStart.positionWorld, normalWorld);
    var rotOrigin = ROS3D.intersectPlane(normalRay, originWorld, normalWorld);

    // rotates from world to plane coords
    var orientationWorld = this.dragStart.orientationWorld.clone().multiply(orientation);
    var orientationWorldInv = orientationWorld.clone().inverse();

    // rotate original and current intersection into local coords
    intersection.sub(rotOrigin);
    intersection.applyQuaternion(orientationWorldInv);

    var origIntersection = this.dragStart.event3d.intersection.point.clone();
    origIntersection.sub(rotOrigin);
    origIntersection.applyQuaternion(orientationWorldInv);

    // compute relative 2d angle
    var a1 = Math.atan2(intersection.y, intersection.z);
    var a2 = Math.atan2(origIntersection.y, origIntersection.z);
    var a = a2 - a1;

    var rot = new THREE.Quaternion();
    rot.setFromAxisAngle(normal, a);

    // rotate
    this.setOrientation(control, rot.multiply(this.dragStart.orientationWorld));

    // offset from drag start position
    event3d.stopPropagation();
  }
};

/**
 * Dispatch the given event type.
 *
 * @param type - the type of event
 * @param control - the control to use
 */
InteractiveMarker.prototype.feedbackEvent = function(type, control) {
  this.dispatchEvent({
    type : type,
    position : this.position.clone(),
    orientation : this.quaternion.clone(),
    controlName : control.name
  });
};

/**
 * Start a drag action.
 *
 * @param control - the control to use
 * @param event3d - the event that caused this
 */
InteractiveMarker.prototype.startDrag = function(control, event3d) {
  if (event3d.domEvent.button === 0) {
    event3d.stopPropagation();
    this.dragging = true;
    this.updateMatrixWorld(true);
    var scale = new THREE.Vector3();
    this.matrixWorld
        .decompose(this.dragStart.positionWorld, this.dragStart.orientationWorld, scale);
    this.dragStart.position = this.position.clone();
    this.dragStart.orientation = this.quaternion.clone();
    this.dragStart.event3d = event3d;

    this.feedbackEvent('user-mousedown', control);
  }
};

/**
 * Stop a drag action.
 *
 * @param control - the control to use
 * @param event3d - the event that caused this
 */
InteractiveMarker.prototype.stopDrag = function(control, event3d) {
  if (event3d.domEvent.button === 0) {
    event3d.stopPropagation();
    this.dragging = false;
    this.dragStart.event3d = {};
    this.onServerSetPose(this.bufferedPoseEvent);
    this.bufferedPoseEvent = undefined;

    this.feedbackEvent('user-mouseup', control);
  }
};

/**
 * Handle a button click.
 *
 * @param control - the control to use
 * @param event3d - the event that caused this
 */
InteractiveMarker.prototype.buttonClick = function(control, event3d) {
  event3d.stopPropagation();
  this.feedbackEvent('user-button-click', control);
};

/**
 * Handle a user pose change for the position.
 *
 * @param control - the control to use
 * @param event3d - the event that caused this
 */
InteractiveMarker.prototype.setPosition = function(control, position) {
  this.position.copy(position);
  this.feedbackEvent('user-pose-change', control);
};

/**
 * Handle a user pose change for the orientation.
 *
 * @param control - the control to use
 * @param event3d - the event that caused this
 */
InteractiveMarker.prototype.setOrientation = function(control, orientation) {
  orientation.normalize();
  this.quaternion.copy(orientation);
  this.feedbackEvent('user-pose-change', control);
};

/**
 * Update the marker based when the pose is set from the server.
 *
 * @param event - the event that caused this
 */
InteractiveMarker.prototype.onServerSetPose = function(event) {
  if (event !== undefined) {
    // don't update while dragging
    if (this.dragging) {
      this.bufferedPoseEvent = event;
    } else {
      var pose = event.pose;
      this.position.copy(pose.position);
      this.quaternion.copy(pose.orientation);
      this.updateMatrixWorld(true);
    }
  }
};

/**
 * Free memory of elements in this marker.
 */
InteractiveMarker.prototype.dispose = function() {
  var that = this;
  this.children.forEach(function(intMarkerControl) {
    intMarkerControl.children.forEach(function(marker) {
      marker.dispose();
      intMarkerControl.remove(marker);
    });
    that.remove(intMarkerControl);
  });
};

Object.assign(ROS3D.InteractiveMarker.prototype, THREE.EventDispatcher.prototype);

export { REVISION, MARKER_ARROW, MARKER_CUBE, MARKER_SPHERE, MARKER_CYLINDER, MARKER_LINE_STRIP, MARKER_LINE_LIST, MARKER_CUBE_LIST, MARKER_SPHERE_LIST, MARKER_POINTS, MARKER_TEXT_VIEW_FACING, MARKER_MESH_RESOURCE, MARKER_TRIANGLE_LIST, INTERACTIVE_MARKER_KEEP_ALIVE, INTERACTIVE_MARKER_POSE_UPDATE, INTERACTIVE_MARKER_MENU_SELECT, INTERACTIVE_MARKER_BUTTON_CLICK, INTERACTIVE_MARKER_MOUSE_DOWN, INTERACTIVE_MARKER_MOUSE_UP, INTERACTIVE_MARKER_NONE, INTERACTIVE_MARKER_MENU, INTERACTIVE_MARKER_BUTTON, INTERACTIVE_MARKER_MOVE_AXIS, INTERACTIVE_MARKER_MOVE_PLANE, INTERACTIVE_MARKER_ROTATE_AXIS, INTERACTIVE_MARKER_MOVE_ROTATE, INTERACTIVE_MARKER_INHERIT, INTERACTIVE_MARKER_FIXED, INTERACTIVE_MARKER_VIEW_FACING, makeColorMaterial, intersectPlane, findClosestPoint, closestAxisPoint, InteractiveMarker };
