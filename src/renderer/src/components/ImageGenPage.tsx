import { App as AntApp } from 'antd'

import ImageGenerationWorkspace from './ImageGenerationWorkspace'
import ImageMaskEditor from './ImageMaskEditor'

export default function ImageGenPage() {
  return (
    <AntApp component={false}>
      <ImageGenerationWorkspace MaskEditorComponent={ImageMaskEditor} />
    </AntApp>
  )
}
