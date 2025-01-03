import { Niivue, NVMeshUtilities, NVImage } from "@niivue/niivue"
import { Niimath } from "@niivue/niimath"
import {
  cuberille,
  setPipelinesBaseUrl as setCuberillePipelinesUrl,
} from "@itk-wasm/cuberille"
import {
  repair,
  smoothRemesh,
  keepLargestComponent,
  setPipelinesBaseUrl as setMeshFiltersPipelinesUrl,
} from "@itk-wasm/mesh-filters"
import { nii2iwi, iwm2meshCore } from "@niivue/cbor-loader"

function formatNumber(value) {
  if (Math.abs(value) >= 1) {
    // For numbers >= 1, use up to 1 decimal place
    return value.toFixed(1)
  } else {
    // For numbers < 1, use up to 3 significant digits
    return value.toPrecision(3)
  }
}

// Use local, vendored WebAssembly module assets
const viteBaseUrl = import.meta.env.BASE_URL
const pipelinesBaseUrl = new URL(
  `${viteBaseUrl}pipelines`,
  document.location.origin
).href
setCuberillePipelinesUrl(pipelinesBaseUrl)
setMeshFiltersPipelinesUrl(pipelinesBaseUrl)

async function main() {
  const niimath = new Niimath()
  await niimath.init()
  niimath.setOutputDataType('input') // call before setting image since this is passed to the image constructor
  const loadingCircle = document.getElementById("loadingCircle")
  saveBtn.onclick = function () {
    if (nv1.meshes.length < 1) {
      window.alert("No mesh open for saving. Use 'Create Mesh'.")
    } else {
      saveDialog.show()
    }
  }
  aboutBtn.onclick = function () {
    window.open("https://github.com/niivue/ct2print", "_blank")
  }
  volumeSelect.onchange = function () {
    const selectedOption = volumeSelect.options[volumeSelect.selectedIndex]
    const txt = selectedOption.text
    let fnm = "./" + txt
    if (volumeSelect.selectedIndex > 6) {
      fnm = "https://niivue.github.io/niivue/images/" + txt
    } else if (volumeSelect.selectedIndex > 1) {
      fnm = "https://niivue.github.io/niivue-demo-images/" + txt
    }
    if (nv1.meshes.length > 0) {
      nv1.removeMesh(nv1.meshes[0])
    }
    if (nv1.volumes.length > 0) {
      nv1.removeVolumeByIndex(0)
    }
    if (!fnm.endsWith(".mgz")) {
      fnm += ".nii.gz"
    }
    console.log(volumeSelect.selectedIndex, fnm)
    nv1.loadVolumes([{ url: fnm }])
  }
  applySaveBtn.onclick = function () {
    if (nv1.meshes.length < 1) {
      return
    }
    let format = "obj"
    if (formatSelect.selectedIndex === 0) {
      format = "mz3"
    }
    if (formatSelect.selectedIndex === 2) {
      format = "stl"
    }
    const scale = 1 / Number(scaleSelect.value)
    const pts = nv1.meshes[0].pts.slice()
    for (let i = 0; i < pts.length; i++) pts[i] *= scale
    NVMeshUtilities.saveMesh(pts, nv1.meshes[0].tris, `mesh.${format}`, true)
  }
  createMeshBtn.onclick = function () {
    if (nv1.meshes.length > 0) nv1.removeMesh(nv1.meshes[0])
    if (nv1.volumes.length < 1) {
      window.alert("Image not loaded. Drag and drop an image.")
    } else {
      remeshDialog.show()
    }
  }
  qualitySelect.onchange = function () {
    const isBetterQuality = Boolean(Number(qualitySelect.value))
    const opacity = 1.0 - (0.5 * Number(isBetterQuality))
    bubbleCheck.disabled = isBetterQuality
    bubbleGroup.style.opacity = opacity
    closeMM.disabled = isBetterQuality
    closeGroup.style.opacity = opacity
  }
  applyBtn.onclick = async function () {
    const isBetterQuality = Boolean(Number(qualitySelect.value))
    const startTime = performance.now()
    if (isBetterQuality)
      await applyQuality()
    else
      await applyFaster()
    console.log(`Execution time: ${Math.round(performance.now() - startTime)} ms`)
  }
  async function applyFaster() {
    const niiBuffer = await nv1.saveImage({volumeByIndex: nv1.volumes.length - 1}).buffer
    const niiFile = new File([niiBuffer], 'image.nii')
    let processor = niimath.image(niiFile)
    loadingCircle.classList.remove('hidden')
    //mesh with specified isosurface
    const isoValue = Number(isoNumber.value)
    //const largestCheckValue = largestCheck.checked
    let reduce = Math.min(Math.max(Number(shrinkPct.value) / 100, 0.01), 1)
    let hollowSz = Number(hollowSelect.value )
    let closeSz = Number(closeMM.value)
    const pixDim = Math.min(Math.min(nv1.volumes[0].hdr.pixDims[1],nv1.volumes[0].hdr.pixDims[2]), nv1.volumes[0].hdr.pixDims[3])
    if ((pixDim < 0.2) && ((hollowSz !== 0) || (closeSz !== 0))) {
      hollowSz *= pixDim
      closeSz *= pixDim
      console.log('Very small pixels, scaling hollow and close values by ', pixDim)
    }
    if (hollowSz < 0) {
      processor = processor.hollow(0.5, hollowSz)
    }
    if ((isFinite(closeSz)) && (closeSz > 0)){
      processor = processor.close(isoValue, closeSz, 2 * closeSz)
    }
    processor = processor.mesh({
      i: isoValue,
      l: largestCheck.checked ? 1 : 0,
      r: reduce,
      b: bubbleCheck.checked ? 1 : 0
    })
    console.log('niimath operation', processor.commands)
    const retBlob = await processor.run('test.mz3')
    const arrayBuffer = await retBlob.arrayBuffer()
    loadingCircle.classList.add('hidden')
    if (nv1.meshes.length > 0)
      nv1.removeMesh(nv1.meshes[0])
    await nv1.loadFromArrayBuffer(arrayBuffer, 'test.mz3')
  }
  async function applyQuality() {
    const volIdx = nv1.volumes.length - 1
    let hdr = nv1.volumes[volIdx].hdr2RAS()
    console.log(hdr.dims)
    let img = nv1.volumes[volIdx].img2RAS().slice()
    // itk ignores scale slope and intercept, so convert isosurface threshold to raw units
    let isoValue = Number(isoNumber.value)
    let hollowInt = Number(hollowSelect.value )
    if (hollowInt < 0) {
      const vol = nv1.volumes[volIdx]
      const niiBuffer = await nv1.saveImage({volumeByIndex: nv1.volumes.length - 1}).buffer
      const niiBlob = new Blob([niiBuffer], { type: 'application/octet-stream' })
      const niiFile = new File([niiBlob], 'input.nii')
      let image = niimath.image(niiFile)
      image = image.gz(0)
      image = image.ras()
      image = image.hollow(isoValue, hollowInt)
      console.log('niimath operation', image.commands)
      const outBlob = await image.run('output.nii') 
      let outFile = new File([outBlob], 'hollow.nii')
      const outVol = await NVImage.loadFromFile({
        file: outFile,
        name: outFile.name
      })
      hdr = outVol.hdr
      img = outVol.img
    }
    if (hdr.scl_slope === 0) {
      hdr.scl_slope = 1
    }
    // itk-wasm ignores rescale slope and intercept
    let isoValueRaw =  (isoValue - hdr.scl_inter) / hdr.scl_slope
    // check isosurface is not too bright or dark
    let mn = img[0]
    let mx = img[0]
    for (let i = 0; i < img.length; i++) {
        mn = Math.min(mn, img[i])
        mx = Math.max(mx, img[i])
    }
    const mnRaw = mn
    mn = (hdr.scl_slope * mn) + hdr.scl_inter
    mx = (hdr.scl_slope * mx) + hdr.scl_inter
    if ((isoValue > mx) || (isoValue < mn)) {
        if (hollowInt < 0)
          alert(`specified isovalue threshold outside intensity range of image voxels ${mn}..${mx} (hint: hollow function may remove some voxels)`)
        else
          alert(`specified isovalue threshold outside intensity range of image voxels ${mn}..${mx}`)
        return
    }
    console.log(`threshold ${isoValue} intensity range ${mn}..${mx}`)
    if (mnRaw !== 0) {
      // ITK-WASM can not handle negative voxels
      //   error: "signed_index_t(result) >= 0."
      for (let i = 0; i < img.length; i++)
        img[i] -= mnRaw
      isoValueRaw -= mnRaw
      console.log(`image intensity translated to remove negative voxels`)
      //n.b. for fix this specific error, we could only apply this correction if mnRaw < 0
      // however the subsequent zero borders assumes darkest voxel is zero
    }
    // ITK-WASM has issues when the edge voxels exceed threshold 
    function zeroBorders(img, dims) {
      const [ndim, nx, ny, nz] = dims // Extract dimensions
      if ((nx < 3) || (ny < 3) || (nz < 3))
        return
      // Zero out the first and last slices
      const nxy = nx * ny
      const lastSliceOffset = (nz - 1) * nxy
      for (let i = 0; i < nxy; i++) {
          img[i] = 0
          img[i+lastSliceOffset] = 0
      }
      // zero first and last columns
      let sliceOffset = 0
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          img[sliceOffset] = 0
          img[sliceOffset + nx - 1] = 0
          sliceOffset += nx
        } //for y
      } // for z
      // zero first and last row
      sliceOffset = 0
      const lastRowOffset = nx * (ny - 1)
      for (let z = 0; z < nz; z++) {
        for (let x = 0; x < nx; x++) {
          img[sliceOffset + x] = 0
          img[sliceOffset + x + lastRowOffset] = 0
        } //for y
        sliceOffset += nxy
      } // for z
      return img;
    } // zeroBorders()
    zeroBorders(img, hdr.dims)
    // next 2 lines currently ignored - required if future itkwasm uses rescale parameters
    hdr.scl_slope = 1
    hdr.scl_inter = 0
    loadingCircle.classList.remove("hidden")
    meshProcessingMsg.classList.remove("hidden")
    meshProcessingMsg.textContent = "Generating mesh from segmentation"
    const itkImage = nii2iwi(hdr, img, false)
    itkImage.size = itkImage.size.map(Number)
    const { mesh } = await cuberille(itkImage, { isoSurfaceValue: isoValueRaw })
    meshProcessingMsg.textContent = "Generating manifold"
    const minimumComponentArea = 1.0
    const maximumHoleArea = 10.0
    const { outputMesh: repairedMesh } = await repair(mesh, {
      maximumHoleArea,
      minimumComponentArea,
    })
    let initialMesh = repairedMesh
    if (largestCheck.checked) {
      console.log('Only retaining largest mesh')
      meshProcessingMsg.textContent = "Keep largest mesh component"
      const { outputMesh: largestComponentMesh } = await keepLargestComponent(
        repairedMesh
      )
      initialMesh = largestComponentMesh
    }
    while (nv1.meshes.length > 0) {
      nv1.removeMesh(nv1.meshes[0])
    }
    const initialNiiMesh = iwm2meshCore(initialMesh)
    const initialNiiMeshBuffer = NVMeshUtilities.createMZ3(
      initialNiiMesh.positions,
      initialNiiMesh.indices,
      false
    )
    await nv1.loadFromArrayBuffer(initialNiiMeshBuffer, "trefoil.mz3")
    saveBtn.disabled = false
    meshProcessingMsg.textContent = "Smoothing and remeshing"
    const smooth = parseInt(smoothSlide.value)
    const shrink = parseFloat(shrinkPct.value)
    console.log(`smoothing iterations ${smooth} shrink percent ${shrink}`)
    const { outputMesh: smoothedMesh } = await smoothRemesh(initialMesh, {
      newtonIterations: smooth,
      numberPoints: shrink,
    })
    const { outputMesh: smoothedRepairedMesh } = await repair(smoothedMesh, { maximumHoleArea, minimumComponentArea })
    const niiMesh = iwm2meshCore(smoothedRepairedMesh)
    loadingCircle.classList.add("hidden")
    meshProcessingMsg.classList.add("hidden")
    while (nv1.meshes.length > 0) {
      nv1.removeMesh(nv1.meshes[0])
    }
    const meshBuffer = NVMeshUtilities.createMZ3(
      niiMesh.positions,
      niiMesh.indices,
      false
    )
    await nv1.loadFromArrayBuffer(meshBuffer, "trefoil.mz3")
  }
  visibleCheck.onchange = function () {
    nv1.setMeshProperty(nv1.meshes[0].id, "visible", this.checked)
  }
  darkCheck.onchange = function () {
    if (this.checked)
      nv1.opts.backColor = [0, 0, 0, 1]
    else
      nv1.opts.backColor = [1, 1, 1, 1]
    nv1.drawScene()
  }
  function handleLocationChange(data) {
    document.getElementById("location").innerHTML =
      "&nbsp;&nbsp;" + data.string
  }
  shaderSelect.onchange = function () {
    nv1.setMeshShader(nv1.meshes[0].id, this.value)
  }
  function handleMeshLoaded() {
    let str = `Mesh has ${nv1.meshes[0].pts.length / 3} vertices and ${
      nv1.meshes[0].tris.length / 3
    } triangles`
    document.getElementById("location").innerHTML = str
    console.log(str)
    shaderSelect.onchange()
  }
  const defaults = {
    onMeshLoaded: handleMeshLoaded,
    onLocationChange: handleLocationChange,
    backColor: [1, 1, 1, 1],
    show3Dcrosshair: true,
    //n.b. we could set "limitFrames4D: 1"
  }
  const nv1 = new Niivue(defaults)
  nv1.attachToCanvas(gl1)
  nv1.isAlphaClipDark = true
  nv1.onImageLoaded = () => {
    const volIdx = nv1.volumes.length - 1
    saveBtn.disabled = true
    const otsu = nv1.findOtsu(3)
    isoLabel.textContent =
      "Isosurface Threshold (" +
      formatNumber(nv1.volumes[0].cal_min) +
      "..." +
      formatNumber(nv1.volumes[0].cal_max) +
      ")"
    isoNumber.value = formatNumber(otsu[1])
    const str = `Image has ${nv1.volumes[0].dims[1]}×${nv1.volumes[0].dims[2]}×${nv1.volumes[0].dims[3]} voxels`
    document.getElementById("location").innerHTML = str
    nv1.setSliceType(nv1.sliceTypeMultiplanar)
    nv1.setPan2Dxyzmm([0, 0, 0, 1])
    console.log(
      "ct2print 20241218 intensity range " +
        isoLabel.textContent +
        " threshold " +
        isoNumber.value
    )
  }
  nv1.setClipPlane([0.1, 0, 120])
  nv1.opts.dragMode = nv1.dragModes.pan
  nv1.setRenderAzimuthElevation(245, 15)
  nv1.opts.multiplanarForceRender = true
  nv1.opts.yoke3Dto2DZoom = true
  nv1.setInterpolation(true)
  await nv1.loadVolumes([{ url: "./Iguana.nii.gz"}])
  qualitySelect.onchange()
}

main()