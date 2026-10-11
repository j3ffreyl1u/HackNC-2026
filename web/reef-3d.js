import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { mergeVertices } from './vendor/BufferGeometryUtils.js';

export function createReef3D(host) {
  let renderer;
  try { renderer=new THREE.WebGLRenderer({alpha:true,antialias:true}); } catch { return undefined; }
  renderer.setPixelRatio(Math.min(devicePixelRatio||1,1.5));
  const surface=renderer.domElement;
  surface.className='reef-depth'; surface.tabIndex=0;
  surface.setAttribute('role','group');
  surface.setAttribute('aria-label','Interactive 3D reef. Drag a fish. With the keyboard, press Enter to select a fish, use arrow keys to move it, and Escape to release.');
  host.append(surface);
  const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera(40,1,.1,80);
  camera.position.set(0,0,24);
  scene.add(new THREE.HemisphereLight(0xd3ffff,0x403363,2.5));
  const light=new THREE.DirectionalLight(0xfff0dc,3.3); light.position.set(-5,12,10);scene.add(light);
  const rim=new THREE.DirectionalLight(0x64e9ff,2);rim.position.set(8,3,-6);scene.add(rim);
  const studio=new THREE.Scene();studio.background=new THREE.Color(0x679ba8);
  for(const [x,y,z,scale] of [[-4,8,4,4],[5,3,-3,2]]) {
    const panel=new THREE.Mesh(new THREE.SphereGeometry(1,16,8),new THREE.MeshBasicMaterial({color:0xeaffff}));
    panel.position.set(x,y,z);panel.scale.setScalar(scale);studio.add(panel);
  }
  const pmrem=new THREE.PMREMGenerator(renderer),environment=pmrem.fromScene(studio,.15);
  scene.environment=environment.texture;pmrem.dispose();
  const timeUniform={value:0}, brush={value:new THREE.Vector3(100,100,100)}, wave={value:0};
  const bubbleGeometry=new THREE.SphereGeometry(1,16,12);
  const bubbleMaterial=new THREE.MeshPhysicalMaterial({color:0xd5fff9,transparent:true,opacity:.32,roughness:.08,metalness:.05,clearcoat:1,clearcoatRoughness:.05,envMapIntensity:1.1,depthWrite:false});
  const bubbles=Array.from({length:16},(_,i)=>{
    const mesh=new THREE.Mesh(bubbleGeometry,bubbleMaterial);mesh.scale.setScalar(.08+(i%5)*.04);scene.add(mesh);return mesh;
  });
  const home=new THREE.Group(); home.position.set(-4,-10.1,0);scene.add(home);
  const base=new THREE.Mesh(new THREE.SphereGeometry(1,48,24),new THREE.MeshStandardMaterial({color:0x8c477e,roughness:.4}));
  base.scale.set(4.7,.85,3.1);home.add(base);
  const stems=[];
  // Each stem has a damped contact spring; its root remains anchored.
  for(let i=0;i<112;i++) {
    const angle=i*2.39996, radius=Math.sqrt((i+.5)/112);
    const x=Math.cos(angle)*radius*4.8,z=Math.sin(angle)*radius*2.9;
    const length=8.6+(1-radius)*4.2+Math.sin(i*7.1)*.7;
    const curve=new THREE.CubicBezierCurve3(new THREE.Vector3(x*.62,0,z*.6),new THREE.Vector3(x*.8,length*.32,z*.75),new THREE.Vector3(x*1.1,length*.75,z),new THREE.Vector3(x*1.08,length,z));
    const bend={value:new THREE.Vector2()};
    const material=new THREE.MeshPhysicalMaterial({color:i%3===0?0xf7c4ad:0xd0abe4,roughness:.24,metalness:.03,clearcoat:1,clearcoatRoughness:.14,envMapIntensity:.6});
    material.onBeforeCompile=shader=>{
      shader.uniforms.reefTime=timeUniform;shader.uniforms.brush=brush;shader.uniforms.reefWave=wave;
      shader.uniforms.contactBend=bend;
      shader.vertexShader='uniform float reefTime; uniform vec3 brush; uniform float reefWave; uniform vec2 contactBend; varying float stemHeight;\n'+shader.vertexShader;
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
        float tip=clamp(position.y/${length.toFixed(3)},0.0,1.0);
        vec3 world=(modelMatrix*vec4(position,1.0)).xyz;
        float nearby=1.0-smoothstep(0.0,2.1,distance(world.xy,brush.xy));
        transformed.x+=pow(tip,2.0)*(sin(reefTime*.8+${i.toFixed(1)})*.19+nearby*sign(world.x-brush.x)*.9+sin(reefTime*4.0+${angle.toFixed(3)})*reefWave*.45);
        transformed.z+=pow(tip,2.0)*sin(reefTime*.65+${angle.toFixed(3)})*.13;
        transformed.xz+=pow(tip,2.0)*contactBend;
        stemHeight=tip;`);
      shader.fragmentShader='varying float stemHeight;\n'+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>','#include <color_fragment>\n diffuseColor.rgb*=mix(vec3(.55,.35,.65),vec3(1.07,1.02,.95),smoothstep(0.0,.85,stemHeight));');
    };
    const tube=new THREE.Mesh(new THREE.TubeGeometry(curve,28,.105+(i%7)*.009,10,false),material);home.add(tube);
    const tip=new THREE.Mesh(new THREE.SphereGeometry(.115+(i%7)*.009,12,8),material);
    // End caps share tube coordinates so the same bending shader follows the stem.
    const end=curve.getPoint(1);tip.geometry.translate(end.x,end.y,end.z);home.add(tip);
    stems.push({curve,bend,velocity:new THREE.Vector2(),samples:[.3,.5,.7,.9,1].map(t=>({t,point:curve.getPoint(t)}))});
  }
  const seaweed=[];
  for(let i=0;i<18;i++) {
    const length=4+(i%5)*.7,geometry=new THREE.PlaneGeometry(.5,length,2,24);geometry.translate(0,length/2,0);
    const material=new THREE.MeshPhysicalMaterial({color:i%2?0x75d94b:0x24cba1,side:THREE.DoubleSide,roughness:.27,clearcoat:.8,clearcoatRoughness:.2});
    material.onBeforeCompile=shader=>{shader.uniforms.reefTime=timeUniform;shader.vertexShader='uniform float reefTime;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
      float leaf=position.y/${length.toFixed(2)};
      transformed.x+=sin(reefTime*.8+leaf*4.0+${i.toFixed(1)})*.55*leaf;
      transformed.z+=cos(reefTime*.6+leaf*3.0+${i.toFixed(1)})*.22*leaf;
      transformed.x*=.35+.65*sin(leaf*3.14159);`);};
    const leaf=new THREE.Mesh(geometry,material);leaf.position.set(i<9?-10+(i%9)*.36:1+(i%9)*.35,-8.2,-1-(i%3));leaf.rotation.y=i*.8;scene.add(leaf);seaweed.push(leaf);
  }
  const fish=[],raycaster=new THREE.Raycaster(),ndc=new THREE.Vector2(),plane=new THREE.Plane(new THREE.Vector3(0,0,1),0);
  let selected,dragOffset=new THREE.Vector3(),lastWidth=0,lastHeight=0,keyboardIndex=-1;
  const status=document.createElement('span');status.className='reef-hint';status.setAttribute('role','status');status.textContent='Drag a fish. Brush the tentacles.';host.querySelector('.view-controls').append(status);
  function cast(event) {
    const rect=surface.getBoundingClientRect();ndc.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);
    raycaster.setFromCamera(ndc,camera);
  }
  function pick(event) { cast(event);const hit=raycaster.intersectObjects(fish.map(f=>f.group),true)[0];return hit&&fish.find(f=>{let object=hit.object;while(object){if(object===f.group)return true;object=object.parent;}return false;}); }
  surface.addEventListener('pointerdown',event=>{
    selected=pick(event);if(!selected)return;
    event.preventDefault();surface.setPointerCapture(event.pointerId);surface.classList.add('dragging');
    plane.constant=-selected.group.position.z;
    const point=new THREE.Vector3();raycaster.ray.intersectPlane(plane,point);dragOffset.copy(selected.group.position).sub(point);
    status.textContent='Fish grabbed. Release to let it swim again.';
  });
  surface.addEventListener('pointermove',event=>{
    cast(event);const point=new THREE.Vector3();
    if(selected) {plane.constant=-selected.group.position.z;raycaster.ray.intersectPlane(plane,point);selected.group.position.copy(point.add(dragOffset));selected.group.position.x=THREE.MathUtils.clamp(selected.group.position.x,-10,7);selected.group.position.y=THREE.MathUtils.clamp(selected.group.position.y,-6,6);}
    else {surface.style.cursor=pick(event)?'grab':'default';plane.constant=0;raycaster.ray.intersectPlane(plane,brush.value);}
    host.dispatchEvent(new Event('reef-ready'));
  });
  function release() {if(selected){selected.releasedAt=timeUniform.value;selected.releaseFrom=selected.group.position.clone();}selected=undefined;surface.classList.remove('dragging');status.textContent='Drag a fish. Brush the tentacles.';}
  surface.addEventListener('pointerup',release);surface.addEventListener('pointercancel',release);surface.addEventListener('lostpointercapture',release);
  surface.addEventListener('pointerleave',()=>{brush.value.set(100,100,100);});
  surface.addEventListener('keydown',event=>{
    if(event.key==='Enter'&&fish.length){event.preventDefault();keyboardIndex=(keyboardIndex+1)%fish.length;selected=fish[keyboardIndex];status.textContent=`Fish ${keyboardIndex+1} selected. Arrow keys move it. Escape releases it.`;}
    else if(event.key==='Escape'){release();host.dispatchEvent(new Event('reef-ready'));}
    else if(selected&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();selected.group.position.x+=event.key==='ArrowLeft'?-.35:event.key==='ArrowRight'?.35:0;selected.group.position.y+=event.key==='ArrowDown'?-.35:event.key==='ArrowUp'?.35:0;host.dispatchEvent(new Event('reef-ready'));}
  });
  const species=['clownfish','blue-tang','yellow-tang','dolphin'];
  let dolphin,previousTime=0;
  const loader=new GLTFLoader();
  Promise.all(species.map(name=>loader.loadAsync(`/models/${name}.glb`))).then(models=>{
    models.forEach((gltf,speciesIndex)=>{
      gltf.scene.updateMatrixWorld(true);
      const baked=new THREE.Group();
      const eyePoints=[[],[]];
      gltf.scene.traverse(mesh=>{
        if(!mesh.isMesh||Array.isArray(mesh.material)||!mesh.material.name.toLowerCase().includes('eye'))return;
        mesh.skeleton?.update();
        for(let j=0;j<mesh.geometry.attributes.position.count;j++) {
          const p=new THREE.Vector3();mesh.getVertexPosition(j,p);p.applyMatrix4(mesh.matrixWorld);eyePoints[p.x<0?0:1].push(p);
        }
      });
      const eyeRegions=eyePoints.filter(points=>points.length).map(points=>{
        const center=new THREE.Vector3();points.forEach(p=>center.add(p));center.divideScalar(points.length);
        return {center,radius:Math.max(...points.map(p=>p.distanceTo(center)))};
      });
      gltf.scene.traverse(mesh=>{if(mesh.isMesh){
        mesh.skeleton?.update();
        const geometry=mesh.geometry.clone(),position=geometry.attributes.position;
        const point=new THREE.Vector3();
        for(let j=0;j<position.count;j++){mesh.getVertexPosition(j,point);point.applyMatrix4(mesh.matrixWorld);position.setXYZ(j,point.x,point.y,point.z);}
        // Eye material groups share the body geometry. Shrink only their vertices,
        // independently on each side of the head, rather than scaling the head.
        const sourceMaterials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
        const eyeSides=[new Set(),new Set()];
        if(sourceMaterials.length===1&&sourceMaterials[0].name.toLowerCase().includes('eye')) {
          for(let j=0;j<position.count;j++)eyeSides[position.getX(j)<0?0:1].add(j);
        }
        for(const part of geometry.groups) {
          if(!sourceMaterials[part.materialIndex]?.name.toLowerCase().includes('eye'))continue;
          for(let j=part.start;j<part.start+part.count;j++) {
            const index=geometry.index?geometry.index.getX(j):j;
            eyeSides[position.getX(index)<0?0:1].add(index);
          }
        }
        for(const vertices of eyeSides) {
          if(!vertices.size)continue;
          const center=new THREE.Vector3();for(const index of vertices)center.add(new THREE.Vector3().fromBufferAttribute(position,index));center.divideScalar(vertices.size);
          for(const index of vertices){point.fromBufferAttribute(position,index).sub(center).multiplyScalar(.46).add(center);position.setXYZ(index,point.x,point.y,point.z);}
        }
        const darkFace=sourceMaterials.length===1&&sourceMaterials[0].name.toLowerCase().includes('dark');
        if(darkFace&&speciesIndex<3) {
          const colors=new Float32Array(position.count*3);
          const bodyColor=new THREE.Color(['#ff791d','#128dde','#ffe346'][speciesIndex]);
          const stripeColor=new THREE.Color(speciesIndex===0?'#733f28':speciesIndex===1?'#204e83':'#b39230');
          for(let j=0;j<position.count;j++) {
            point.fromBufferAttribute(position,j);
            const eye=eyeRegions.find(e=>point.distanceTo(e.center)<e.radius*3.0);
            // Blend the raised eye rim into the head and flatten its protrusion.
            if(eye)position.setX(j,eye.center.x-Math.sign(eye.center.x)*eye.radius*.7);
            (eye?bodyColor:stripeColor).toArray(colors,j*3);
          }
          geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
        }
        geometry.deleteAttribute('skinIndex');geometry.deleteAttribute('skinWeight');geometry.deleteAttribute('normal');
        const smoothGeometry=mergeVertices(geometry,.0001);smoothGeometry.computeVertexNormals();
        smoothGeometry.computeBoundingBox();smoothGeometry.computeBoundingSphere();
        const mats=Array.isArray(mesh.material)?mesh.material:[mesh.material];
        const soft=mats.map(mat=>{const m=mat.clone();
          if(m.name==='Clownfish_Main')m.color.set('#ff791d');
          else if(m.name==='Clownfish_Dark')m.color.set('#8d502e');
          else if(m.name==='Clownfish_Light')m.color.set('#fffce8');
          else if(m.name.includes('Dark')&&m.name.includes('Blue'))m.color.set('#204e83');
          else if(m.name.includes('Dark')&&m.name.includes('Yellow'))m.color.set('#b39230');
          else if(m.name.includes('Main')&&m.name.includes('Blue'))m.color.set('#128dde');
          else if(m.name.includes('Main')&&m.name.includes('Yellow'))m.color.set('#ffe346');
          if(darkFace){m.color.set('#ffffff');m.vertexColors=true;}
          m.roughness=.32;m.metalness=0;m.envMapIntensity=.45;m.flatShading=false;m.side=THREE.DoubleSide;
          m.onBeforeCompile=shader=>{shader.uniforms.fishTime=timeUniform;shader.vertexShader='uniform float fishTime;\n'+shader.vertexShader;shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n transformed.x+=sin(fishTime*4.0+position.z*2.0)*.025*abs(position.z);');};return m;});
        baked.add(new THREE.Mesh(smoothGeometry,Array.isArray(mesh.material)?soft:soft[0]));
      }});
      gltf.scene=baked;
    });
    for(let i=0;i<6;i++) {
      const speciesIndex=i<2?0:i%2?1:2;
      const gltf=models[speciesIndex],asset=gltf.scene.clone(true);
      const bounds=new THREE.Box3().setFromObject(asset),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
      const group=new THREE.Group(),visual=new THREE.Group(),offset=new THREE.Group();
      offset.position.copy(center).multiplyScalar(-1);offset.add(asset);visual.add(offset);
      visual.scale.setScalar((i<2?3.2-i*.6:2.0)/Math.max(size.x,size.y,size.z));
      visual.rotation.y=Math.PI/2;group.add(visual);scene.add(group);

      fish.push({group,phase:i*1.4,home:-4,baseY:i<2?-.3-i*1.6:3.8+(i-2)*.3,radius:i<2?1.1:.7,contactOffset:new THREE.Vector3(),contactVelocity:new THREE.Vector3()});
    }
    const model=models[3].scene.clone(true),box=new THREE.Box3().setFromObject(model),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
    dolphin=new THREE.Group();const pivot=new THREE.Group();model.position.sub(center);pivot.add(model);pivot.scale.setScalar(6.3/Math.max(size.x,size.y,size.z));pivot.rotation.y=Math.PI/2;dolphin.add(pivot);scene.add(dolphin);
    surface.dataset.modelReady='true';status.textContent='Drag a fish. Brush the tentacles.';host.dispatchEvent(new Event('reef-ready'));
  }).catch(()=>{status.textContent='Fish models could not load. Refresh to try again.';});

  return {render(time,width,height,pointer,animate,ripple=false){
    const mobile=width<760,viewHeight=mobile?500:height;
    if(lastWidth!==width||lastHeight!==viewHeight){lastWidth=width;lastHeight=viewHeight;renderer.setSize(width,viewHeight);camera.aspect=width/viewHeight;camera.updateProjectionMatrix();}
    camera.position.set(mobile?-4:0,0,mobile?27:24);camera.lookAt(mobile?-4:0,0,0);
    home.scale.set(mobile?1.04:1.17,mobile?1.02:1.14,1.15);home.position.y=mobile?-12.2:-10.1;
    const t=time;timeUniform.value=t;wave.value=animate&&ripple?1:0;if(!animate)brush.value.set(100,100,100);
    const dt=animate?Math.min(1/30,Math.max(0,t-previousTime)):0;previousTime=t;
    fish.forEach((f,i)=>{if(f===selected)return;const speed=.19+i*.008,angle=t*speed+f.phase,travel=i<2?2.8:4;const target=new THREE.Vector3(f.home+Math.sin(angle)*travel,f.baseY+Math.sin(angle*1.4)*.8,Math.cos(angle)*2.4);
      if(f.releaseFrom){const progress=THREE.MathUtils.clamp((t-f.releasedAt)/2,0,1);f.group.position.lerpVectors(f.releaseFrom,target,1-(1-progress)**3);if(progress===1)f.releaseFrom=undefined;}else f.group.position.copy(target);
      const yaw=Math.atan2(-Math.sin(angle)*2.4,Math.cos(angle)*travel);
      const pitch=Math.atan2(Math.cos(angle*1.4)*1.12,Math.hypot(Math.cos(angle)*travel,Math.sin(angle)*2.4))*.3;
      const orientation=new THREE.Quaternion().setFromEuler(new THREE.Euler(0,yaw,pitch));
      if(!f.initialized){f.group.quaternion.copy(orientation);f.initialized=true;}
      else if(animate)f.group.quaternion.slerp(orientation,1-Math.exp(-3.5*dt));
    });
    home.updateMatrixWorld(true);
    const worldPoint=new THREE.Vector3(),repulsion=new THREE.Vector3();
    for(const stem of stems) {
      const target=new THREE.Vector2();
      for(const sample of stem.samples) {
        worldPoint.copy(sample.point);worldPoint.x+=stem.bend.value.x*sample.t**2;worldPoint.z+=stem.bend.value.y*sample.t**2;home.localToWorld(worldPoint);
        for(const swimmer of fish) {
          repulsion.copy(worldPoint).sub(swimmer.group.position);
          const distance=repulsion.length(),reach=swimmer.radius+.23;
          if(distance>=reach)continue;
          if(distance<.001)repulsion.set(.1,0,.1);repulsion.normalize();
          const penetration=reach-distance;
          target.x+=repulsion.x*penetration*1.4;target.y+=repulsion.z*penetration*1.4;
          if(animate&&swimmer!==selected)swimmer.contactVelocity.addScaledVector(repulsion,-penetration*dt*3);
        }
      }
      target.clampLength(0,1.5);
      if(animate) {
        stem.velocity.x+=((target.x-stem.bend.value.x)*48-stem.velocity.x*12)*dt;
        stem.velocity.y+=((target.y-stem.bend.value.y)*48-stem.velocity.y*12)*dt;
        stem.bend.value.addScaledVector(stem.velocity,dt);stem.bend.value.clampLength(0,1.6);
      } else {stem.bend.value.copy(target);stem.velocity.set(0,0);}
    }
    if(animate)for(const swimmer of fish) {
      if(swimmer===selected)continue;
      swimmer.contactVelocity.addScaledVector(swimmer.contactOffset,-8*dt).multiplyScalar(Math.exp(-5*dt));
      swimmer.contactOffset.addScaledVector(swimmer.contactVelocity,dt).clampLength(0,.6);
      swimmer.group.position.add(swimmer.contactOffset);
    }
    if(dolphin){const angle=t*.16+1;dolphin.position.set(-3+Math.sin(angle)*6.5,7.0+Math.sin(angle*1.5)*.25,-3.0+Math.cos(angle)*.6);dolphin.rotation.y=Math.atan2(-Math.sin(angle),Math.cos(angle)*6.5);dolphin.rotation.z=Math.sin(angle)*.08;}
    bubbles.forEach((bubble,i)=>bubble.position.set(-10+(i*.83)%13+Math.sin(t*.22+i)*.2,((t*(.35+i*.016)+i*1.3)%19)-9,-3+(i%4)*1.2));
    renderer.setRenderTarget(null);renderer.setViewport(0,0,width,viewHeight);renderer.setScissorTest(false);renderer.autoClear=true;
    renderer.render(scene,camera);
  }};
}
