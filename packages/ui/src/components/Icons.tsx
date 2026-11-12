// 線画アイコン（24px グリッド、currentColor）。外部アイコンライブラリに依存しない。
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 10.5 12 3.5l8.5 7" />
    <path d="M5.5 9v10.5h4.5v-6h4v6h4.5V9" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Svg>
);

export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
    <circle cx="15" cy="7" r="2" />
    <circle cx="9" cy="17" r="2" />
  </Svg>
);

export const ReplyIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11.5a7.5 7.5 0 0 1-11 6.6L4 19.5l1.4-4.6A7.5 7.5 0 1 1 20 11.5Z" />
  </Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg {...p} strokeWidth={2.6}>
    <path d="M5.5 12h.01M12 12h.01M18.5 12h.01" />
  </Svg>
);

export const PenIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10v4Z" />
    <path d="m13 7 4 4" />
  </Svg>
);

export const SparkleIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5c.6 4.3 2.2 5.9 6.5 6.5-4.3.6-5.9 2.2-6.5 6.5-.6-4.3-2.2-5.9-6.5-6.5 4.3-.6 5.9-2.2 6.5-6.5Z" />
    <path d="M18.5 15.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5Z" />
  </Svg>
);

export const ImageIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m20.5 16-4.5-4.5-8.5 8" />
  </Svg>
);

export const BackIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);

/** 同期待ち: 雲＋上向き矢印 */
export const CloudUpIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 18.5h-.5a4 4 0 0 1-.6-7.95A6 6 0 0 1 17.6 9.1a4.7 4.7 0 0 1-.1 9.4H17" />
    <path d="M12 19.5v-7M9 15l3-3 3 3" />
  </Svg>
);

/** オフライン: 斜線入りの雲 */
export const CloudOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6.3A6 6 0 0 1 17.6 9.1a4.7 4.7 0 0 1 2.6 8M16.5 18.5H6.5a4 4 0 0 1-.6-7.95c.2-.9.6-1.7 1.1-2.4" />
    <path d="m3.5 3.5 17 17" />
  </Svg>
);

/** 同期中: 循環矢印 */
export const SyncIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1" />
    <path d="M17.5 3.5v3.5H14M6.5 20.5V17H10" />
  </Svg>
);

/** 同期失敗: 三角の警告 */
export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 4.2 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4.5M12 17.2h.01" />
  </Svg>
);

/** 競合: 分岐 */
export const ConflictIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.5" cy="5.5" r="2" />
    <circle cx="6.5" cy="18.5" r="2" />
    <circle cx="17.5" cy="7.5" r="2" />
    <path d="M6.5 7.5v9M17.5 9.5c0 4-4 4.5-9.4 7.6" />
  </Svg>
);

export const HeartIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20Z" />
  </Svg>
);

export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <path d="M8 14h.01M12 14h.01M16 14h.01M8 17.2h.01M12 17.2h.01" strokeWidth={2.4} />
  </Svg>
);

export const BellIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15l1.5-2Z" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
  </Svg>
);

export const FilterIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);

export const ChevronIcon = ({ dir = 'right', ...p }: IconProps & { dir?: 'left' | 'right' }) => (
  <Svg {...p}>
    <path d={dir === 'left' ? 'm14.5 6-6 6 6 6' : 'm9.5 6 6 6-6 6'} />
  </Svg>
);

/** 範囲選択のスクリーンショット（四隅の枠＋中心） */
export const ScreenshotIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <path d="M9 12h6M12 9v6" />
  </Svg>
);
