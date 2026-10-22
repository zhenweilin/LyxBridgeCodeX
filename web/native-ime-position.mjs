// Native IME rectangles use logical pixels in their owning Qt window. Convert
// through that window's rendered image, including popup offsets and CSS scale.
export function nativeImePosition({inputMethod,surface,image,viewport,scrollLeft=0,scrollTop=0}) {
  if(!inputMethod?.enabled || !inputMethod.rect || !surface || !image || !viewport)return;
  const rect=inputMethod.rect;
  const values=[rect.x,rect.y,rect.width,rect.height,surface.width,surface.height,
    image.left,image.top,image.width,image.height,viewport.left,viewport.top,scrollLeft,scrollTop];
  if(!values.every(Number.isFinite) || surface.width<=0 || surface.height<=0
    || image.width<=0 || image.height<=0 || rect.width<0 || rect.height<=0)return;
  const xScale=image.width/surface.width,yScale=image.height/surface.height;
  return {
    left:image.left-viewport.left+scrollLeft+rect.x*xScale,
    top:image.top-viewport.top+scrollTop+rect.y*yScale,
    height:Math.max(1,rect.height*yScale),
  };
}
