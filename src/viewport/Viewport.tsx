import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ModelAsset, StudioStore } from "../model/store";

interface Props {
  store: StudioStore;
  onStatus: (message: string) => void;
  onExportReady: (exporter: { exportSTL: () => void } | null) => void;
  onLoadReady: (load: (file: File) => Promise<void>) => void;
}

export default function Viewport({ store, onStatus, onExportReady, onLoadReady }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<{
    scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer;
    controls: OrbitControls; pivot: THREE.Group; model: THREE.Object3D | null; frame: number;
  } | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#111923");
    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.01, 10000);
    camera.position.set(4, 3, 5);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x526070, 2));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 7, 5); scene.add(key);
    const grid = new THREE.GridHelper(10, 20, 0x526477, 0x293746);
    scene.add(grid);
    const axes = new THREE.AxesHelper(1.2); scene.add(axes);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    // The loaded object is centred inside `pivot`; the store's transform is applied to the pivot,
    // so scaling happens around the model's centre.
    const pivot = new THREE.Group();
    scene.add(pivot);
    const state = { scene, camera, renderer, controls, pivot, model: null as THREE.Object3D | null, frame: 0 };
    const syncTransform = () => {
      const s = store.getState();
      const t = s.preview ?? s.transform;
      pivot.position.set(...t.position);
      pivot.scale.set(...t.scale);
    };
    const unsubscribe = store.subscribe(syncTransform);
    engineRef.current = state;

    const resize = () => {
      if (!mount) return;
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    const observer = new ResizeObserver(resize); observer.observe(mount);
    const animate = () => {
      state.frame = requestAnimationFrame(animate);
      controls.update(); renderer.render(scene, camera);
    };
    animate();

    onExportReady({
      exportSTL: () => {
        if (!state.model) return;
        import("three/examples/jsm/exporters/STLExporter.js").then(({ STLExporter }) => {
          const exporter = new STLExporter();
          const data = exporter.parse(state.pivot, { binary: true });
          const blob = new Blob([data], { type: "application/octet-stream" });
          downloadBlob(blob, "model-export.stl");
        });
      },
    });

    onLoadReady(async (file: File) => {
      const ext = file.name.split(".").pop()?.toLowerCase();
      let object: THREE.Object3D;
      if (ext === "stl") {
        const buffer = await file.arrayBuffer();
        const geometry = new STLLoader().parse(buffer);
        geometry.computeVertexNormals();
        object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: "#a8b7c7", roughness: 0.68, metalness: 0.08 }));
      } else if (ext === "glb" || ext === "gltf") {
        const url = URL.createObjectURL(file);
        try {
          const gltf = await new GLTFLoader().loadAsync(url);
          object = gltf.scene;
        } finally { URL.revokeObjectURL(url); }
      } else {
        throw new Error("Supported formats in this prototype: STL, GLB and GLTF.");
      }
      if (state.model) pivot.remove(state.model);
      // Measure the new model at identity so a previous model's transform can't skew its bounds.
      pivot.position.set(0, 0, 0);
      pivot.scale.set(1, 1, 1);
      pivot.updateMatrixWorld(true);
      object.name = file.name;
      state.model = object;
      pivot.add(object);
      const box = new THREE.Box3().setFromObject(object);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      object.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      camera.position.set(maxDim * 1.8, maxDim * 1.3, maxDim * 1.8);
      controls.target.set(0, 0, 0);
      camera.near = Math.max(maxDim / 1000, 0.001);
      camera.far = maxDim * 100;
      camera.updateProjectionMatrix();
      controls.update();
      let vertices = 0, triangles = 0;
      object.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry) {
          const pos = mesh.geometry.getAttribute("position");
          if (pos) vertices += pos.count;
          const index = mesh.geometry.index;
          triangles += index ? index.count / 3 : (pos?.count ?? 0) / 3;
        }
      });
      const asset: ModelAsset = { name: file.name, vertices, triangles, baseSize: [size.x, size.y, size.z] };
      store.loadAsset(asset);
      syncTransform();
      onStatus(`Loaded ${file.name}`);
    });

    return () => {
      unsubscribe();
      cancelAnimationFrame(state.frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      engineRef.current = null;
      onExportReady(null);
    };
  }, []);

  return <div className="viewport" ref={mountRef} />;
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
