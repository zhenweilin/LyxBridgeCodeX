// CSS zoom changes layout bounds along with the rendered native pixels.
// transform:scale leaves the original box in overflow calculations, exposing
// a second horizontal scrollbar when the panel is narrower than LyX's minimum.
export function nativeViewportSize(bounds) {
  if(!(bounds.width>0 && bounds.height>0))return null;
  const width=Math.min(2560,Math.max(480,Math.round(bounds.width)));
  const scale=Math.min(1,bounds.width/width);
  // Ask LyX for enough logical height to fill the panel after fitting its
  // minimum width. Otherwise a narrow editor leaves a large blank lower area.
  return {width,height:Math.min(1800,Math.max(300,Math.round(bounds.height/scale)))};
}

export function fitNativeViewport(container, frame, availableWidth) {
  const scale=Math.min(1,availableWidth/frame.width);
  Object.assign(container.style,{
    width:`${frame.width}px`,height:`${frame.height}px`,
    zoom:String(scale),transform:'none',
  });
  return scale;
}
