import { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { getResolvedTheme } from '../../lib/theme';
import { getNodeColor, getNodeRadius, getLinkColor } from './graphHelpers';
import type { PGNode, PGLink, PGGraphData, ForceParams } from './PixiGraph';

interface ThreeGraphProps {
  graphData: PGGraphData;
  width: number;
  height: number;
  hoveredNode: PGNode | null;
  selectedNodes: PGNode[];
  selectedCluster: number | null;
  methodology: string;
  isLocalMode: boolean;
  focusNodeId: string | null;
  forceParams: ForceParams;
  onNodeClick: (node: PGNode, event: any) => void;
  onNodeHover: (node: PGNode | null) => void;
  onNodeRightClick: (node: PGNode, event: any) => void;
  onBackgroundClick: () => void;
}

function createCircleTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(8, 8, 0, 8, 8, 8);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.2, 'rgba(230, 242, 255, 0.83)');
    grad.addColorStop(0.5, 'rgba(147, 197, 253, 0.25)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 16, 16);
  }
  return new THREE.CanvasTexture(canvas);
}

export function ThreeGraph(props: ThreeGraphProps) {
  const {
    graphData,
    width,
    height,
    hoveredNode,
    selectedCluster,
    methodology,
    forceParams,
    onNodeClick,
    onNodeHover,
    onNodeRightClick,
    onBackgroundClick,
  } = props;

  const mountRef = useRef<HTMLDivElement>(null);
  
  // ── 内部存储各种 ThreeJS 实例引用 ──
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<TrackballControls | null>(null);
  const workerRef = useRef<Worker | null>(null);
  
  // 3D 渲染对象映射与缓存
  const nodeGroupsRef = useRef<Map<string, THREE.Group>>(new Map());
  const nodeMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map()); // 用于 Raycaster
  const nodeIdByMeshUuidRef = useRef<Map<string, string>>(new Map());
  const linkLinesRef = useRef<THREE.Group[]>([]); // 边 Group
  const starfieldRef = useRef<THREE.Points | null>(null);
  const gridCageRef = useRef<THREE.Group | null>(null);

  // ── 主题模式 ──
  const [resolvedTheme, setResolvedTheme] = useState(() => getResolvedTheme());
  useEffect(() => {
    const onThemeChange = () => setResolvedTheme(getResolvedTheme());
    window.addEventListener('zettel:theme-changed', onThemeChange);
    return () => window.removeEventListener('zettel:theme-changed', onThemeChange);
  }, []);

  const isDark = resolvedTheme === 'dark';

  // ── 监听 props.hoveredNode 并动态更新样式 ──
  useEffect(() => {
    const isHighlight = hoveredNode !== null;
    const adj = new Map<string, Set<string>>();
    
    if (isHighlight) {
      for (const n of graphData.nodes) adj.set(n.id, new Set());
      for (const l of graphData.links) {
        const sid = typeof l.source === 'string' ? l.source : l.source.id;
        const tid = typeof l.target === 'string' ? l.target : l.target.id;
        adj.get(sid)?.add(tid);
        adj.get(tid)?.add(sid);
      }
    }

    const neighborIds = hoveredNode ? (adj.get(hoveredNode.id) || new Set<string>()) : new Set<string>();

    nodeGroupsRef.current.forEach((group, nodeId) => {
      const isSelf = hoveredNode && nodeId === hoveredNode.id;
      const isNeighbor = hoveredNode && neighborIds.has(nodeId);
      
      const mesh = group.getObjectByName('sphere') as THREE.Mesh;
      const label = group.getObjectByName('label') as THREE.Sprite;
      
      if (mesh) {
        const mat = mesh.material as THREE.MeshBasicMaterial;
        if (!hoveredNode) {
          mat.opacity = 0.9;
        } else {
          mat.opacity = (isSelf || isNeighbor) ? 1.0 : 0.18;
        }
      }
      
      if (label) {
        if (!hoveredNode) {
          label.visible = true;
        } else {
          label.visible = !!(isSelf || isNeighbor);
        }
      }
    });

    linkLinesRef.current.forEach((edgeGroup) => {
      const meta = edgeGroup.userData;
      if (!meta) return;
      
      const line = edgeGroup.getObjectByName('line') as THREE.Line;
      const arrow = edgeGroup.getObjectByName('arrow') as THREE.Mesh;
      
      const lineMat = line?.material as THREE.LineBasicMaterial;
      const arrowMat = arrow?.material as THREE.MeshBasicMaterial;
      
      if (!hoveredNode) {
        if (lineMat) {
          lineMat.color.set(meta.baseColor);
          lineMat.opacity = meta.isSemantic ? 0.25 : 0.45;
        }
        if (arrowMat) {
          arrowMat.color.set(meta.baseColor);
          arrowMat.opacity = meta.isSemantic ? 0.35 : 0.65;
        }
      } else {
        const isRelated = meta.sId === hoveredNode.id || meta.tId === hoveredNode.id;
        if (isRelated) {
          if (lineMat) {
            lineMat.color.set(meta.hlColor);
            lineMat.opacity = 0.95;
          }
          if (arrowMat) {
            arrowMat.color.set(meta.hlColor);
            arrowMat.opacity = 0.95;
          }
        } else {
          if (lineMat) lineMat.opacity = 0.04;
          if (arrowMat) arrowMat.opacity = 0.04;
        }
      }
    });
  }, [hoveredNode, graphData]);

  // ── 主 WebGL 场景初始化 ──
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 4000);
    camera.position.set(0, 0, 450);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.domElement.style.cursor = 'default'; // 显式重载 CSS grab 光标，以普通指针为基底
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // 升级为 TrackballControls，实现 360 度全向无死角飞行旋转
    const controls = new TrackballControls(camera, renderer.domElement);
    controls.rotateSpeed = 1.8;
    controls.zoomSpeed = 1.2;
    controls.panSpeed = 1.0;
    controls.minDistance = 40;
    controls.maxDistance = 1500;
    controls.staticMoving = false;
    controls.dynamicDampingFactor = 0.12; // 启用带阻尼的惯性滑动
    controls.target.set(0, 0, 0);
    controlsRef.current = controls;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight.position.set(200, 400, 300);
    scene.add(dirLight);

    // 启动 Web Worker
    const worker = new Worker(new URL('./forceWorker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    // 监听位置更新
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data;
      if (d.type === 'positions') {
        const buf = d.buffer as Float32Array;
        
        nodeGroupsRef.current.forEach((group, id) => {
          const idx = graphData.nodes.findIndex(n => n.id === id);
          if (idx !== -1 && group.visible) {
            if (activeDragNodeIdRef.current === id) return;
            
            const x = buf[idx * 3];
            const y = buf[idx * 3 + 1];
            const z = buf[idx * 3 + 2];
            group.position.set(x, y, z);
          }
        });

        // 连线与 3D 箭头位置刷新
        linkLinesRef.current.forEach((edgeGroup) => {
          if (!edgeGroup.visible) return;
          const sGroup = nodeGroupsRef.current.get(edgeGroup.userData.sId);
          const tGroup = nodeGroupsRef.current.get(edgeGroup.userData.tId);
          if (sGroup && tGroup) {
            const sPos = sGroup.position;
            const tPos = tGroup.position;

            const line = edgeGroup.getObjectByName('line') as THREE.Line;
            if (line) {
              const posAttr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
              posAttr.setXYZ(0, sPos.x, sPos.y, sPos.z);
              posAttr.setXYZ(1, tPos.x, tPos.y, tPos.z);
              posAttr.needsUpdate = true;
            }

            const arrow = edgeGroup.getObjectByName('arrow') as THREE.Mesh;
            if (arrow) {
              const dir = new THREE.Vector3().subVectors(tPos, sPos);
              const dist = dir.length();
              if (dist > 12) {
                dir.normalize();
                arrow.visible = true;
                arrow.position.copy(sPos).addScaledVector(dir, dist * 0.64);
                const up = new THREE.Vector3(0, 1, 0);
                const quaternion = new THREE.Quaternion().setFromUnitVectors(up, dir);
                arrow.quaternion.copy(quaternion);
              } else {
                arrow.visible = false;
              }
            }
          }
        });
      }
    };

    // ── 3D 节点鼠标拖拽及点击事件流 ──
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    
    const activeDragNodeIdRef = { current: null as string | null };
    const dragPlane = new THREE.Plane();
    const dragIntersection = new THREE.Vector3();
    const tempDir = new THREE.Vector3();
    
    let clickStartX = 0;
    let clickStartY = 0;
    let clickStartTime = 0;

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      clickStartX = e.clientX;
      clickStartY = e.clientY;
      clickStartTime = Date.now();

      raycaster.setFromCamera(mouse, camera);
      const visibleMeshes = Array.from(nodeMeshesRef.current.entries())
        .filter(([id]) => nodeGroupsRef.current.get(id)?.visible)
        .map(([, mesh]) => mesh);

      const intersects = raycaster.intersectObjects(visibleMeshes);
      
      if (intersects.length === 0) {
        // 点击空白背景 → 不阻止传播，让 TrackballControls 正常处理旋转
        renderer.domElement.style.cursor = 'grabbing';
        return;
      }

      // ★ 命中节点：阻止事件传播到 TrackballControls（bubble 阶段），
      // 使其永远不会进入 mouseDown 状态，从而避免释放鼠标后的
      // 360° 自由观看模式和视角抽动。
      // 本 handler 注册在 capture 阶段（见 addEventListener 第三参数 true）。
      e.stopPropagation();

      const intersectedMesh = intersects[0].object as THREE.Mesh;
      const nodeId = nodeIdByMeshUuidRef.current.get(intersectedMesh.uuid);
      
      if (nodeId && e.button === 0) {
        activeDragNodeIdRef.current = nodeId;

        const nodeGroup = nodeGroupsRef.current.get(nodeId);
        if (nodeGroup) {
          camera.getWorldDirection(tempDir);
          dragPlane.setFromNormalAndCoplanarPoint(tempDir.negate(), nodeGroup.position);
          
          worker.postMessage({
            type: 'pin',
            id: nodeId,
            x: nodeGroup.position.x,
            y: nodeGroup.position.y,
            z: nodeGroup.position.z
          });
        }

        window.addEventListener('pointermove', handlePointerMoveDrag);
        window.addEventListener('pointerup', handlePointerUpDrag);
        e.preventDefault();
      }
    };

    const handlePointerMoveDrag = (e: PointerEvent) => {
      const activeId = activeDragNodeIdRef.current;
      if (!activeId) return;

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      
      if (raycaster.ray.intersectPlane(dragPlane, dragIntersection)) {
        const group = nodeGroupsRef.current.get(activeId);
        if (group) {
          group.position.copy(dragIntersection);

          linkLinesRef.current.forEach((edgeGroup) => {
            if (edgeGroup.userData.sId === activeId || edgeGroup.userData.tId === activeId) {
              const sGroup = nodeGroupsRef.current.get(edgeGroup.userData.sId);
              const tGroup = nodeGroupsRef.current.get(edgeGroup.userData.tId);
              if (sGroup && tGroup) {
                const sPos = sGroup.position;
                const tPos = tGroup.position;
                const line = edgeGroup.getObjectByName('line') as THREE.Line;
                if (line) {
                  const posAttr = line.geometry.getAttribute('position') as THREE.BufferAttribute;
                  posAttr.setXYZ(0, sPos.x, sPos.y, sPos.z);
                  posAttr.setXYZ(1, tPos.x, tPos.y, tPos.z);
                  posAttr.needsUpdate = true;
                }
                const arrow = edgeGroup.getObjectByName('arrow') as THREE.Mesh;
                if (arrow) {
                  const dir = new THREE.Vector3().subVectors(tPos, sPos);
                  const dist = dir.length();
                  if (dist > 12) {
                    dir.normalize();
                    arrow.visible = true;
                    arrow.position.copy(sPos).addScaledVector(dir, dist * 0.64);
                    const up = new THREE.Vector3(0, 1, 0);
                    const quaternion = new THREE.Quaternion().setFromUnitVectors(up, dir);
                    arrow.quaternion.copy(quaternion);
                  } else {
                    arrow.visible = false;
                  }
                }
              }
            }
          });
        }

        worker.postMessage({
          type: 'dragMove',
          id: activeId,
          x: dragIntersection.x,
          y: dragIntersection.y,
          z: dragIntersection.z
        });
      }
    };

    const handlePointerUpDrag = (e: PointerEvent) => {
      const activeId = activeDragNodeIdRef.current;
      if (activeId) {
        worker.postMessage({ type: 'unpin', id: activeId });
        activeDragNodeIdRef.current = null;
      }
      renderer.domElement.style.cursor = 'default';
      window.removeEventListener('pointermove', handlePointerMoveDrag);
      window.removeEventListener('pointerup', handlePointerUpDrag);
    };

    const handlePointerMoveHover = (e: MouseEvent) => {
      if (activeDragNodeIdRef.current) return;

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      
      const visibleMeshes = Array.from(nodeMeshesRef.current.entries())
        .filter(([id]) => nodeGroupsRef.current.get(id)?.visible)
        .map(([, mesh]) => mesh);

      const intersects = raycaster.intersectObjects(visibleMeshes);
      
      if (intersects.length > 0) {
        const intersectedMesh = intersects[0].object as THREE.Mesh;
        const nodeId = nodeIdByMeshUuidRef.current.get(intersectedMesh.uuid);
        if (nodeId) {
          const matchedNode = graphData.nodes.find(n => n.id === nodeId);
          if (matchedNode) {
            renderer.domElement.style.cursor = 'pointer';
            onNodeHover(matchedNode as any);
            return;
          }
        }
      }
      if (e.buttons === 0) {
        renderer.domElement.style.cursor = 'default';
      }
      onNodeHover(null);
    };

    const handleCanvasPointerUpGlobal = (e: PointerEvent) => {
      renderer.domElement.style.cursor = 'default';
      
      const dragDist = Math.hypot(e.clientX - clickStartX, e.clientY - clickStartY);
      const clickTime = Date.now() - clickStartTime;
      
      if (dragDist > 6 || clickTime > 300) return;

      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const visibleMeshes = Array.from(nodeMeshesRef.current.entries())
        .filter(([id]) => nodeGroupsRef.current.get(id)?.visible)
        .map(([, mesh]) => mesh);

      const intersects = raycaster.intersectObjects(visibleMeshes);

      if (intersects.length > 0) {
        const intersectedMesh = intersects[0].object as THREE.Mesh;
        const nodeId = nodeIdByMeshUuidRef.current.get(intersectedMesh.uuid);
        if (nodeId) {
          const matchedNode = graphData.nodes.find(n => n.id === nodeId);
          if (matchedNode) {
            // ★ 阻止 TrackballControls 处理此 pointerup（虽然 pointerdown 已被
            // 拦截使其 mouseDown 为 false，但双重保险）
            e.stopPropagation();
            if (e.button === 0) {
              onNodeClick(matchedNode as any, e);
            } else if (e.button === 2) {
              onNodeRightClick(matchedNode as any, e);
            }
            return;
          }
        }
      }
      if (e.button === 0) {
        onBackgroundClick();
      }
    };

    // ★ capture 阶段注册 pointerdown，确保在 TrackballControls 的 bubble 阶段 handler 之前执行
    renderer.domElement.addEventListener('pointerdown', handlePointerDown, true);
    // ★ capture 阶段注册 pointerup，确保节点点击事件不被 TrackballControls 干扰
    renderer.domElement.addEventListener('pointerup', handleCanvasPointerUpGlobal, true);
    renderer.domElement.addEventListener('mousemove', handlePointerMoveHover);

    // 动画循环
    let animationFrameId: number;
    const animate = () => {
      animationFrameId = requestAnimationFrame(animate);
      controls.update();

      if (starfieldRef.current) {
        starfieldRef.current.rotation.y += 0.0001;
        starfieldRef.current.rotation.x += 0.00005;
      }

      nodeGroupsRef.current.forEach((group) => {
        if (group.visible) {
          const label = group.getObjectByName('label') as THREE.Sprite;
          if (label) {
            label.quaternion.copy(camera.quaternion);
          }
        }
      });

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animationFrameId);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown, true);
      renderer.domElement.removeEventListener('pointerup', handleCanvasPointerUpGlobal, true);
      renderer.domElement.removeEventListener('mousemove', handlePointerMoveHover);
      window.removeEventListener('pointermove', handlePointerMoveDrag);
      window.removeEventListener('pointerup', handlePointerUpDrag);
      
      controls.dispose();
      
      nodeGroupsRef.current.forEach(group => {
        group.traverse(child => {
          if (child instanceof THREE.Mesh) {
            child.geometry.dispose();
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
            else child.material.dispose();
          }
          if (child instanceof THREE.Sprite) {
            child.material.map?.dispose();
            child.material.dispose();
          }
        });
        scene.remove(group);
      });
      nodeGroupsRef.current.clear();
      nodeMeshesRef.current.clear();
      nodeIdByMeshUuidRef.current.clear();

      linkLinesRef.current.forEach(edgeGroup => {
        edgeGroup.traverse(child => {
          if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
            child.geometry.dispose();
            if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
            else child.material.dispose();
          }
        });
        scene.remove(edgeGroup);
      });
      linkLinesRef.current = [];

      if (starfieldRef.current) {
        starfieldRef.current.geometry.dispose();
        (starfieldRef.current.material as THREE.Material).dispose();
      }
      if (gridCageRef.current) {
        gridCageRef.current.traverse(child => {
          if (child instanceof THREE.LineSegments) {
            child.geometry.dispose();
            (child.material as THREE.Material).dispose();
          }
        });
        scene.remove(gridCageRef.current);
      }

      worker.terminate();
      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 2. 响应亮暗主题切换 ──
  useEffect(() => {
    const scene = sceneRef.current;
    const renderer = rendererRef.current;
    if (!scene || !renderer) return;

    if (starfieldRef.current) {
      scene.remove(starfieldRef.current);
      starfieldRef.current.geometry.dispose();
      (starfieldRef.current.material as THREE.Material).dispose();
      starfieldRef.current = null;
    }
    if (gridCageRef.current) {
      scene.remove(gridCageRef.current);
      gridCageRef.current.traverse(child => {
        if (child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          (child.material as THREE.Material).dispose();
        }
      });
      gridCageRef.current = null;
    }

    renderer.setClearColor(isDark ? 0x0b0f19 : 0xf8fafc, 1);

    if (isDark) {
      const count = 1200;
      const geom = new THREE.BufferGeometry();
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const radius = 800;
      const starTexture = createCircleTexture();

      for (let i = 0; i < count; i++) {
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 2 - 1);
        const r = radius * (0.5 + Math.random() * 0.5);

        positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        positions[i * 3 + 2] = r * Math.cos(phi);

        const rand = Math.random();
        if (rand < 0.6) {
          colors[i * 3] = 0.95; colors[i * 3 + 1] = 0.95; colors[i * 3 + 2] = 1.0;
        } else if (rand < 0.8) {
          colors[i * 3] = 0.65; colors[i * 3 + 1] = 0.82; colors[i * 3 + 2] = 1.0;
        } else {
          colors[i * 3] = 0.83; colors[i * 3 + 1] = 0.68; colors[i * 3 + 2] = 0.98;
        }
      }

      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const mat = new THREE.PointsMaterial({
        size: 5.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        map: starTexture,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });

      const starfield = new THREE.Points(geom, mat);
      starfield.name = 'zettel-starfield';
      scene.add(starfield);
      starfieldRef.current = starfield;
    }
  }, [isDark]);

  // ── 3. 响应 graphData 变化进行增量同步 ──
  useEffect(() => {
    const scene = sceneRef.current;
    const worker = workerRef.current;
    if (!scene || !worker) return;

    nodeGroupsRef.current.forEach(group => { group.visible = false; });
    linkLinesRef.current.forEach(edgeGroup => { edgeGroup.visible = false; });

    const nodes = graphData.nodes;
    const links = graphData.links;

    nodes.forEach(n => {
      let group = nodeGroupsRef.current.get(n.id);
      
      if (group) {
        group.visible = true;
        const mesh = group.getObjectByName('sphere') as THREE.Mesh;
        if (mesh) {
          const color = getNodeColor(n, selectedCluster !== null, methodology);
          (mesh.material as THREE.MeshLambertMaterial).color.set(color);
        }
      } else {
        group = new THREE.Group();
        const color = getNodeColor(n, selectedCluster !== null, methodology);
        const radius = Math.max(1.8, getNodeRadius(n) * 0.38);

        const geom = new THREE.SphereGeometry(radius, 16, 16);
        const mat = new THREE.MeshLambertMaterial({
          color: new THREE.Color(color),
          transparent: true,
          opacity: 0.9,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.name = 'sphere';
        group.add(mesh);

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const labelText = n.label.length > 15 ? n.label.slice(0, 15) + '…' : n.label;
        canvas.width = 160;
        canvas.height = 36;
        if (ctx) {
          ctx.font = '20px system-ui, -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.strokeStyle = isDark ? 'rgba(15, 23, 42, 0.95)' : 'rgba(255, 255, 255, 0.95)';
          ctx.lineWidth = 4;
          ctx.strokeText(labelText, 80, 18);
          ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a';
          ctx.fillText(labelText, 80, 18);
        }
        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
        const sprite = new THREE.Sprite(spriteMat);
        
        sprite.scale.set(54, 12, 1);
        sprite.position.set(0, radius + 4.5, 0);
        sprite.name = 'label';
        group.add(sprite);

        group.position.set(
          (Math.random() * 200 - 100),
          (Math.random() * 200 - 100),
          (Math.random() * 200 - 100)
        );

        scene.add(group);
        nodeGroupsRef.current.set(n.id, group);
        nodeMeshesRef.current.set(n.id, mesh);
        nodeIdByMeshUuidRef.current.set(mesh.uuid, n.id);
      }
    });

    linkLinesRef.current.forEach(edgeGroup => scene.remove(edgeGroup));
    const newLines: THREE.Group[] = [];

    links.forEach(l => {
      const sId = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const tId = typeof l.target === 'object' ? (l.target as any).id : l.target;

      const isSemantic = l.edge_type === 'semantic';
      const baseColorStr = getLinkColor(l.label, false, l.edge_type);
      const hlColorStr = getLinkColor(l.label, true, l.edge_type);

      const edgeGroup = new THREE.Group();
      edgeGroup.name = 'edge-group';

      const geom = new THREE.BufferGeometry();
      const posArr = new Float32Array(6);
      geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
      const mat = new THREE.LineBasicMaterial({
        color: new THREE.Color(baseColorStr),
        transparent: true,
        opacity: isSemantic ? 0.25 : 0.45,
      });
      const line = new THREE.Line(geom, mat);
      line.name = 'line';
      edgeGroup.add(line);

      const arrowGeom = new THREE.ConeGeometry(1.5, 5.0, 4);
      const arrowMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(baseColorStr),
        transparent: true,
        opacity: isSemantic ? 0.35 : 0.65,
      });
      const arrow = new THREE.Mesh(arrowGeom, arrowMat);
      arrow.name = 'arrow';
      arrow.visible = false;
      edgeGroup.add(arrow);

      edgeGroup.userData = { sId, tId, baseColor: baseColorStr, hlColor: hlColorStr, isSemantic };
      
      scene.add(edgeGroup);
      newLines.push(edgeGroup);
    });
    linkLinesRef.current = newLines;

    worker.postMessage({
      type: 'init',
      nodes: nodes.map(n => ({ id: n.id, is_hub: n.is_hub, is_orphan: n.is_orphan })),
      links: links.map(l => {
        const sId = typeof l.source === 'object' ? (l.source as any).id : l.source;
        const tId = typeof l.target === 'object' ? (l.target as any).id : l.target;
        return { source: sId, target: tId, edge_type: l.edge_type, weight: l.weight, label: l.label };
      }),
      params: forceParams,
      warm: true,
    });
    worker.postMessage({ type: 'reheat', alpha: 0.3 });

  }, [graphData]);

  // ── 响应容器外部尺寸缩放变化 ──
  useEffect(() => {
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    const controls = controlsRef.current;
    if (camera && renderer) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      if (controls && 'handleResize' in controls) {
        controls.handleResize();
      }
    }
  }, [width, height]);

  // ── 物理参数动态热重载更新 ──
  useEffect(() => {
    const worker = workerRef.current;
    if (worker) {
      worker.postMessage({
        type: 'params',
        params: forceParams,
      });
    }
  }, [forceParams]);

  return (
    <div 
      ref={mountRef} 
      style={{ 
        width: '100%', 
        height: '100%', 
        position: 'relative', 
        overflow: 'hidden',
        background: isDark ? '#0b0f19' : '#f8fafc' 
      }} 
    />
  );
}
