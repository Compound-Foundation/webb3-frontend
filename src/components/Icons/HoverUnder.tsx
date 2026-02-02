import { Theme } from '@hooks/useThemeManager';

export const HoverUnder = ({
  className = '',
  long = false,
  theme,
}: {
  className?: string;
  long?: boolean;
  theme: Theme;
}) => {
  const stopColor = theme === Theme.Light ? '#0C131A' : '#F5F7FA';

  return long ? (
    <svg width="104" height="2" viewBox="0 0 104 2" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line
        x1="0.75"
        y1="1.25"
        x2="103.25"
        y2="1.25"
        stroke="url(#paint0_linear_7197_123000)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="4 4"
      />
      <defs>
        <linearGradient
          id="paint0_linear_7197_123000"
          x1="102.844"
          y1="1.5"
          x2="0.0563276"
          y2="4.16915"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={stopColor} stopOpacity="0" />
          <stop offset="0.0906538" stopColor={stopColor} stopOpacity="0.25" />
          <stop offset="0.541667" stopColor={stopColor} stopOpacity="0.5" />
          <stop offset="0.89243" stopColor={stopColor} stopOpacity="0.25" />
          <stop offset="0.994792" stopColor={stopColor} stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  ) : (
    <svg className={className} width="53" height="2" viewBox="0 0 53 2" fill="none" xmlns="http://www.w3.org/2000/svg">
      <line
        x1="0.75"
        y1="1.25"
        x2="52.25"
        y2="1.25"
        stroke="url(#paint0_linear_7197_122993)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="4 4"
      />
      <defs>
        <linearGradient
          id="paint0_linear_7197_122993"
          x1="52.4111"
          y1="1.5"
          x2="0.00256129"
          y2="2.19355"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={stopColor} stopOpacity="0" />
          <stop offset="0.0906538" stopColor={stopColor} stopOpacity="0.25" />
          <stop offset="0.541667" stopColor={stopColor} stopOpacity="0.5" />
          <stop offset="0.89243" stopColor={stopColor} stopOpacity="0.25" />
          <stop offset="0.994792" stopColor={stopColor} stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
};
