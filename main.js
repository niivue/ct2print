import { Niivue, NVMeshUtilities, NVImage } from "@niivue/niivue";
import { Niimath } from "@niivue/niimath"
import {
  cuberille,
  setPipelinesBaseUrl as setCuberillePipelinesUrl,
} from "@itk-wasm/cuberille";
import {
  repair,
  smoothRemesh,
  keepLargestComponent,
  setPipelinesBaseUrl as setMeshFiltersPipelinesUrl,
} from "@itk-wasm/mesh-filters";
import { nii2iwi, iwm2meshCore } from "@niivue/cbor-loader";

function formatNumber(value) {
  if (Math.abs(value) >= 1) {
    // For numbers >= 1, use up to 1 decimal place
    return value.toFixed(1);
  } else {
    // For numbers < 1, use up to 3 significant digits
    return value.toPrecision(3);
  }
}

// Use local, vendored WebAssembly module assets
const viteBaseUrl = import.meta.env.BASE_URL;
const pipelinesBaseUrl = new URL(
  `${viteBaseUrl}pipelines`,
  document.location.origin
).href;
setCuberillePipelinesUrl(pipelinesBaseUrl);
setMeshFiltersPipelinesUrl(pipelinesBaseUrl);

async function main() {
  const niimath = new Niimath()
  await niimath.init()
  const loadingCircle = document.getElementById("loadingCircle");
  let startTime = null;
  saveBtn.onclick = function () {
    if (nv1.meshes.length < 1) {
      window.alert("No mesh open for saving. Use 'Create Mesh'.");
    } else {
      saveDialog.show();
    }
  };
  aboutBtn.onclick = function () {
    window.open("https://github.com/niivue/ct2print", "_blank");
  };
  volumeSelect.onchange = function () {
    const selectedOption = volumeSelect.options[volumeSelect.selectedIndex];
    const txt = selectedOption.text;
    let fnm = "./" + txt;
    if (volumeSelect.selectedIndex > 4) {
      fnm = "https://niivue.github.io/niivue/images/" + txt;
    } else if (volumeSelect.selectedIndex > 1) {
      fnm = "https://niivue.github.io/niivue-demo-images/" + txt;
    }
    if (nv1.meshes.length > 0) {
      nv1.removeMesh(nv1.meshes[0]);
    }
    if (nv1.volumes.length > 0) {
      nv1.removeVolumeByIndex(0);
    }
    if (volumeSelect.selectedIndex > 5) {
      nv1.loadMeshes([{ url: fnm }]);
    } else {
      if (!fnm.endsWith(".mgz")) {
        fnm += ".nii.gz";
      }
      nv1.loadVolumes([{ url: fnm }]);
    }
  };
  applySaveBtn.onclick = function () {
    if (nv1.meshes.length < 1) {
      return;
    }
    let format = "obj";
    if (formatSelect.selectedIndex === 0) {
      format = "mz3";
    }
    if (formatSelect.selectedIndex === 2) {
      format = "stl";
    }
    const scale = 1 / Number(scaleSelect.value);
    const pts = nv1.meshes[0].pts.slice();
    for (let i = 0; i < pts.length; i++) pts[i] *= scale;
    NVMeshUtilities.saveMesh(pts, nv1.meshes[0].tris, `mesh.${format}`, true);
  };
  createMeshBtn.onclick = function () {
    if (nv1.meshes.length > 0) nv1.removeMesh(nv1.meshes[0]);
    if (nv1.volumes.length < 1) {
      window.alert("Image not loaded. Drag and drop an image.");
    } else {
      remeshDialog.show();
    }
  };
  applyBtn.onclick = async function () {
    const volIdx = nv1.volumes.length - 1;
    const isoValue = Number(isoNumber.value);
    let hdr = nv1.volumes[volIdx].hdr;
    let img = nv1.volumes[volIdx].img;
    let hollowInt = Number(hollowSelect.value )
    if (hollowInt < 0){
      const vol = nv1.volumes[volIdx]
      const niiBuffer = await nv1.saveImage({volumeByIndex: nv1.volumes.length - 1}).buffer
      const niiBlob = new Blob([niiBuffer], { type: 'application/octet-stream' })
      const niiFile = new File([niiBlob], 'input.nii')
      // with niimath wasm ZLIB builds, isGz seems to be the default output type:
      // see: https://github.com/rordenlab/niimath/blob/9f3a301be72c331b90ef5baecb7a0232e9b47ba4/src/core.c#L201
      // also added new option to set outputDataType in niimath in version 0.3.0 (published 20 Dec 2024)
      niimath.setOutputDataType('input') // call before setting image since this is passed to the image constructor
      let image = niimath.image(niiFile)
      image = image.hollow(isoValue, hollowInt)
      // must use .gz extension because niimath will create .nii.gz by default, so
      // wasm file system commands will look for this, not .nii. 
      // Error 44 will happen otherwise (file not found error)
      const outBlob = await image.run('output.nii.gz') 
      let outFile = new File([outBlob], 'hollow.nii.gz')
      const outVol = await NVImage.loadFromFile({
        file: outFile,
        name: outFile.name
      })
      hdr = outVol.hdr
      img = outVol.img
    }
    loadingCircle.classList.remove("hidden");
    meshProcessingMsg.classList.remove("hidden");
    meshProcessingMsg.textContent = "Generating mesh from segmentation";
    const itkImage = nii2iwi(hdr, img, false);
    itkImage.size = itkImage.size.map(Number);
    console.log(
      `volume ${volIdx} dimensions ${itkImage.size} with iso-value ${isoValue}`
    );
    const { mesh } = await cuberille(itkImage, { isoSurfaceValue: isoValue });
    meshProcessingMsg.textContent = "Generating manifold";
    const { outputMesh: repairedMesh } = await repair(mesh, {
      maximumHoleArea: 50.0,
    });
    meshProcessingMsg.textContent = "Keep largest mesh component";
    const { outputMesh: largestOnly } = await keepLargestComponent(
      repairedMesh
    );
    while (nv1.meshes.length > 0) {
      nv1.removeMesh(nv1.meshes[0]);
    }
    const initialNiiMesh = iwm2meshCore(largestOnly);
    const initialNiiMeshBuffer = NVMeshUtilities.createMZ3(
      initialNiiMesh.positions,
      initialNiiMesh.indices,
      false
    );
    await nv1.loadFromArrayBuffer(initialNiiMeshBuffer, "trefoil.mz3");
    saveBtn.disabled = false;
    meshProcessingMsg.textContent = "Smoothing and remeshing";
    const smooth = parseInt(smoothSlide.value);
    const shrink = parseFloat(shrinkPct.value);
    const { outputMesh: smoothedMesh } = await smoothRemesh(largestOnly, {
      newtonIterations: smooth,
      numberPoints: shrink,
    });
    const { outputMesh: smoothedRepairedMesh } = await repair(smoothedMesh, { maximumHoleArea: 50.0 })
    const niiMesh = iwm2meshCore(smoothedRepairedMesh)
    loadingCircle.classList.add("hidden");
    meshProcessingMsg.classList.add("hidden");
    while (nv1.meshes.length > 0) {
      nv1.removeMesh(nv1.meshes[0]);
    }
    const meshBuffer = NVMeshUtilities.createMZ3(
      niiMesh.positions,
      niiMesh.indices,
      false
    );
    await nv1.loadFromArrayBuffer(meshBuffer, "trefoil.mz3");
  };

  visibleCheck.onchange = function () {
    nv1.setMeshProperty(nv1.meshes[0].id, "visible", this.checked);
  };
  function handleLocationChange(data) {
    document.getElementById("location").innerHTML =
      "&nbsp;&nbsp;" + data.string;
  }
  shaderSelect.onchange = function () {
    nv1.setMeshShader(nv1.meshes[0].id, this.value);
  };
  function handleMeshLoaded() {
    let str = `Mesh has ${nv1.meshes[0].pts.length / 3} vertices and ${
      nv1.meshes[0].tris.length / 3
    } triangles`;
    if (startTime) str += ` ${Date.now() - startTime}ms`;
    document.getElementById("location").innerHTML = str;
    console.log(str);
    shaderSelect.onchange();
    startTime = null;
  }
  const defaults = {
    onMeshLoaded: handleMeshLoaded,
    onLocationChange: handleLocationChange,
    backColor: [1, 1, 1, 1],
    show3Dcrosshair: true,
  };
  const nv1 = new Niivue(defaults);
  nv1.attachToCanvas(gl1);
  nv1.isAlphaClipDark = true;
  nv1.onImageLoaded = () => {
    saveBtn.disabled = true;
    const otsu = nv1.findOtsu(3);
    isoLabel.textContent =
      "Isosurface Threshold (" +
      formatNumber(nv1.volumes[0].cal_min) +
      "..." +
      formatNumber(nv1.volumes[0].cal_max) +
      ")";
    isoNumber.value = formatNumber(otsu[1]);
    const str = `Image has ${nv1.volumes[0].dims[1]}×${nv1.volumes[0].dims[2]}×${nv1.volumes[0].dims[3]} voxels`;
    document.getElementById("location").innerHTML = str;
    nv1.setSliceType(nv1.sliceTypeMultiplanar);
    console.log(
      "ct2print 20241218 intensity range " +
        isoLabel.textContent +
        " threshold " +
        isoNumber.value
    );
  };
  nv1.setClipPlane([0.1, 0, 120]);
  nv1.opts.dragMode = nv1.dragModes.pan;
  nv1.setRenderAzimuthElevation(245, 15);
  nv1.opts.multiplanarForceRender = true;
  nv1.opts.yoke3Dto2DZoom = true;
  nv1.setInterpolation(true);
  await nv1.loadVolumes([{ url: "./tinyT1.nii.gz" }]);
}

main();
