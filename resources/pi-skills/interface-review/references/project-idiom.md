# pi-studio 界面修复的「项目写法」

写任何修复建议前先读这里，确保建议是 pi-studio 自己的惯用法，而不是引入第二套样式系统。

## 技术栈事实

- **框架**：Electron + React 19 + TypeScript（`src/renderer/src`）
- **组件库**：antd 6（`import { Button, ... } from 'antd'`）+ LobeHub UI（`@lobehub/ui`）
- **样式方案**：`antd-style` 的 `createStyles`（CSS-in-JS），这是**主力**；Tailwind 4 作为补充（`@tailwindcss/vite`，项目里有，但组件样式应以 antd-style 为主，避免两套并存）
- **主题**：antd Design Token（`token.*`），通过 `appearance: 'dark' | 'light'` prop 切换深浅色
- **图标**：`lucide-react`
- **动画**：antd token 里的 motion（`token.motionDurationFast` / `token.motionEaseOut`），无 framer-motion / motion 依赖

## 写样式的标准姿势

组件内用 `createStyles` 拿 token：

```tsx
import { createStyles } from 'antd-style'

const useStyles = createStyles(({ token, css }) => ({
  row: css`
    display: flex;
    gap: ${token.paddingSM}px;
    background: ${token.colorBgLayout};
    border: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextSecondary};
    transition: background ${token.motionDurationFast} ${token.motionEaseOut};
  `,
}))

// 组件内：const { styles } = useStyles()
```

## 硬性规则

1. **颜色一律走 token，禁止硬编码 hex/rgb**。深色模式靠 `appearance` 切 token 自动适配，硬编码颜色会在深色模式下漏光。常用：`colorBgLayout` / `colorBgContainer` / `colorBorderSecondary` / `colorText` / `colorTextSecondary` / `colorTextTertiary` / `colorFillSecondary` / `colorFillQuaternary` / `colorPrimary` / `colorError`。
2. **深浅色都要测**。发现只在 `light` 下好看、`dark` 下对比度不足的问题，报出来并指出该用哪个 token。
3. **间距/圆角/动效走 token**，不写魔法数字：`token.paddingXS/SM/MD/LG`、`token.borderRadius`、`token.borderRadiusLG`、`token.motionDurationFast/Mid`、`token.motionEaseOut`。
4. **不引入第三套样式**：组件内不要为改一个值而加 Tailwind utility，除非该文件已普遍用 Tailwind。优先 `createStyles`。
5. **`transition` 只过渡具体属性**（`background`、`color`、`transform`），禁止 `transition: all`。
6. **主题切换不能闪**：涉及 `appearance` 切换的过渡要禁用/强制 reflow，见 `references/review-checklist.md` 的「动效」节。

## 该往哪报

- 若是某个共享 token / `App.tsx` 全局样式的问题 → 报在源头，列出所有受影响组件，只报一次。
- 若是某个组件内联样式的问题 → 报在组件。
- 复用 antd 组件能力（`Button`/`Modal`/`Drawer`/`Tooltip`/`Segmented`）优于自造 div 组件；自造的才需要审键盘/焦点/ARIA。
