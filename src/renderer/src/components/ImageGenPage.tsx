import ImageGenerationWorkspace from './ImageGenerationWorkspace'
import ImageMaskEditor from './ImageMaskEditor'

export default function ImageGenPage() {
  return <ImageGenerationWorkspace MaskEditorComponent={ImageMaskEditor} />
}
