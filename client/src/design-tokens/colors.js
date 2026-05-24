// 北歐極簡色票 — JS 端使用（圖表配色、JS 計算等）
// Tailwind 用的同一份 token 在 src/index.css 內以 @theme 定義
export const colors = {
  sage: {
    50: '#f0f7f2',
    100: '#dceee0',
    200: '#b8ddc1',
    400: '#7bbe8a',
    500: '#5da97a',
    600: '#468a60',
    700: '#36694a',
  },
  slateBlue: {
    400: '#6b829e',
    500: '#4d6580',
    600: '#3a4f66',
  },
  linen: {
    50: '#fafbfa',
    100: '#f8fafc',
    200: '#f1f5f4',
  },
};

export const semantic = {
  primary: colors.sage[500],
  primaryHover: colors.sage[600],
  primarySoft: colors.sage[50],
  accent: colors.slateBlue[500],
  bg: colors.linen[100],
  surface: '#ffffff',
  border: '#e8e8ed',
  text: '#1d1d1f',
  textMuted: '#86868b',
};
