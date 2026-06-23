import { theme } from 'antd'

const { darkAlgorithm, defaultAlgorithm } = theme

type AppTheme = {
  algorithm: typeof darkAlgorithm | typeof defaultAlgorithm
  token: Record<string, unknown>
  components: Record<string, unknown>
}

const sharedTokens = {
  borderRadius: 8,
  borderRadiusLG: 12,
  borderRadiusSM: 6,
  borderRadiusXS: 4,
  fontSize: 14,
  fontSizeSM: 12,
  fontSizeLG: 16,
  lineHeight: 1.6,
  fontFamily:
    '"Geist Variable", Geist, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei UI", sans-serif',
  fontFamilyCode:
    '"Geist Mono", "SF Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  controlHeight: 36,
  controlHeightSM: 28,
  controlHeightLG: 40,
  motionDurationFast: '0.1s',
  motionDurationMid: '0.2s',
  motionDurationSlow: '0.3s',
  motionEaseOut: 'cubic-bezier(0.23, 1, 0.32, 1)',
}

/** LobeHub light theme — gray.light + gray.lightA, primary = near-black accent. */
const lightBase = {
  colorBgLayout: '#f8f8f8',
  colorBgBase: '#ffffff',
  colorBgContainer: '#ffffff',
  colorBgElevated: '#ffffff',
  colorBgSpotlight: '#dddddd',
  colorBgMask: 'rgba(0,0,0,0.44)',
  colorFill: 'rgba(0,0,0,0.12)',
  colorFillSecondary: 'rgba(0,0,0,0.06)',
  colorFillTertiary: 'rgba(0,0,0,0.03)',
  colorFillQuaternary: 'rgba(0,0,0,0.015)',
  colorBorder: '#e3e3e3',
  colorBorderSecondary: '#eeeeee',
  colorText: '#080808',
  colorTextSecondary: '#666666',
  colorTextTertiary: '#999999',
  colorTextQuaternary: '#bbbbbb',
  colorTextPlaceholder: '#cccccc',
  colorTextDescription: '#999999',
  colorTextDisabled: '#dddddd',
  colorPrimary: '#2f6feb',
  colorPrimaryHover: '#1f5fdb',
  colorPrimaryActive: '#1a4fb8',
  colorPrimaryBg: '#eef3fe',
  colorPrimaryBgHover: '#dde9fd',
  colorPrimaryBorder: '#a9c4f7',
  colorPrimaryBorderHover: '#7ea6f1',
  colorPrimaryText: '#2f6feb',
  colorPrimaryTextHover: '#1f5fdb',
  colorError: '#ef4444',
  colorErrorBg: 'rgba(239,68,68,0.08)',
  colorErrorBorder: 'rgba(239,68,68,0.20)',
  colorSuccess: '#22c55e',
  colorSuccessBg: 'rgba(34,197,94,0.08)',
  colorSuccessBorder: 'rgba(34,197,94,0.20)',
  colorWarning: '#f59e0b',
  colorWarningBg: 'rgba(245,158,11,0.08)',
  colorWarningBorder: 'rgba(245,158,11,0.20)',
  boxShadow: '0 20px 20px -8px rgba(0,0,0,0.08)',
  boxShadowSecondary: '0 8px 16px -4px rgba(0,0,0,0.06)',
}

/** LobeHub dark theme — gray.dark + gray.darkA, primary = bright blue accent. */
const darkBase = {
  colorBgLayout: '#000000',
  colorBgBase: '#0d0d0d',
  colorBgContainer: '#0d0d0d',
  colorBgElevated: '#1a1a1a',
  colorBgSpotlight: '#2d2d2d',
  colorBgMask: 'rgba(0,0,0,0.44)',
  colorFill: 'rgba(255,255,255,0.16)',
  colorFillSecondary: 'rgba(255,255,255,0.10)',
  colorFillTertiary: 'rgba(255,255,255,0.06)',
  colorFillQuaternary: 'rgba(255,255,255,0.02)',
  colorBorder: '#252525',
  colorBorderSecondary: '#1e1e1e',
  colorText: '#ffffff',
  colorTextSecondary: '#aaaaaa',
  colorTextTertiary: '#6f6f6f',
  colorTextQuaternary: '#555555',
  colorTextPlaceholder: '#444444',
  colorTextDescription: '#6f6f6f',
  colorTextDisabled: '#333333',
  colorPrimary: '#4c8dff',
  colorPrimaryHover: '#6fa3ff',
  colorPrimaryActive: '#3a78e0',
  colorPrimaryBg: '#15233d',
  colorPrimaryBgHover: '#1c2f50',
  colorPrimaryBorder: '#2c4d85',
  colorPrimaryBorderHover: '#3d65a8',
  colorPrimaryText: '#4c8dff',
  colorPrimaryTextHover: '#6fa3ff',
  colorError: '#f87171',
  colorErrorBg: 'rgba(248,113,113,0.10)',
  colorErrorBorder: 'rgba(248,113,113,0.25)',
  colorSuccess: '#4ade80',
  colorSuccessBg: 'rgba(74,222,128,0.08)',
  colorSuccessBorder: 'rgba(74,222,128,0.20)',
  colorWarning: '#fbbf24',
  colorWarningBg: 'rgba(251,191,36,0.10)',
  colorWarningBorder: 'rgba(251,191,36,0.25)',
  boxShadow: '0 20px 20px -8px rgba(0,0,0,0.24)',
  boxShadowSecondary: '0 8px 16px -4px rgba(0,0,0,0.2)',
}

function buildTheme(mode: 'dark' | 'light'): AppTheme {
  const base = mode === 'dark' ? darkBase : lightBase
  const token = { ...base, ...sharedTokens }

  return {
    algorithm: mode === 'dark' ? darkAlgorithm : defaultAlgorithm,
    token,
    components: {
      Modal: {
        contentBg: base.colorBgElevated,
        headerBg: base.colorBgElevated,
        footerBg: base.colorBgElevated,
        titleFontSize: 14,
      },
      Input: {
        activeBorderColor: base.colorPrimaryBorder,
        hoverBorderColor: mode === 'dark' ? '#444444' : '#bbbbbb',
        colorBgContainer: base.colorBgContainer,
        colorBorder: base.colorBorder,
      },
      Select: {
        colorBgContainer: base.colorBgContainer,
        colorBorder: base.colorBorder,
      },
      Button: {
        defaultBorderColor: base.colorBorder,
        defaultBg: base.colorBgContainer,
        defaultColor: base.colorTextSecondary,
      },
      Tooltip: {
        colorBgSpotlight: mode === 'dark' ? '#2d2d2d' : '#333333',
        colorTextLightSolid: '#ffffff',
      },
      Scrollbar: {
        colorScrollbarThumb: mode === 'dark' ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.18)',
        colorScrollbarThumbHover: mode === 'dark' ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.30)',
      },
    },
  }
}

export const piDarkTheme = buildTheme('dark')
export const piLightTheme = buildTheme('light')
