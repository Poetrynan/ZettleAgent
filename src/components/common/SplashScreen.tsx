import { useEffect, useState, memo } from 'react';

const TAGLINE = 'Think · Connect · Evolve';

interface SplashScreenProps {
  progress: number;
  stage: string;
  isReady: boolean;
}

/**
 * Startup screen. The app icon draws itself — one ink stroke through three
 * linked notes, the middle one in vermilion — then the wordmark and tagline
 * settle in underneath. Same artwork as logo/zettleagent-icon.svg.
 */
export const SplashScreen = memo(function SplashScreen({ isReady }: SplashScreenProps) {
  const [exiting, setExiting] = useState(false);
  const [unmounted, setUnmounted] = useState(false);

  useEffect(() => {
    if (isReady && !exiting) {
      setExiting(true);
    }
  }, [isReady, exiting]);

  const handleTransitionEnd = (e: React.TransitionEvent) => {
    if (e.propertyName === 'opacity' && exiting) {
      setUnmounted(true);
    }
  };

  if (unmounted) return null;

  return (
    <div
      className={`splash-screen ${exiting ? 'splash-exit' : ''}`}
      onTransitionEnd={handleTransitionEnd}
      aria-hidden={exiting}
    >
      <div className="splash-grid-mesh" />

      <div className="splash-stack">
        <svg className="splash-icon" viewBox="100 100 824 824" aria-hidden="true">
          <defs>
            <linearGradient id="splash-paper" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#FAF8F3" />
              <stop offset="1" stopColor="#EFEBE3" />
            </linearGradient>
          </defs>
          <rect className="splash-icon-tile" x="100" y="100" width="824" height="824" rx="185" fill="url(#splash-paper)" />
          <rect x="102" y="102" width="820" height="820" rx="183" fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="4" />
          <path
            className="splash-icon-stroke"
            pathLength={1}
            d="M318 330 H706 L318 694 H706"
            fill="none"
            stroke="#1C1B19"
            strokeWidth="66"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle className="splash-icon-node" style={{ '--node-delay': '0.3s' } as React.CSSProperties} cx="318" cy="330" r="62" fill="#1C1B19" />
          <circle className="splash-icon-node" style={{ '--node-delay': '1.05s' } as React.CSSProperties} cx="706" cy="694" r="62" fill="#1C1B19" />
          <circle className="splash-icon-node is-mark" style={{ '--node-delay': '1.3s' } as React.CSSProperties} cx="512" cy="512" r="62" fill="#C8432B" />
        </svg>

        <div className="splash-title logo-wordmark">
          <span className="logo-zettel">Zettel</span>
          <span className="logo-lambda-wrap">
            <span className="logo-agent-lambda">Λ</span>
          </span>
          <span className="logo-agent-rest">gent</span>
        </div>

        <div className="splash-tagline-row">
          <span className="splash-tagline-rule splash-tagline-rule--left" aria-hidden="true" />
          <p className="splash-tagline" aria-label={TAGLINE}>
            {Array.from(TAGLINE).map((char, i) => (
              <span
                key={`${i}-${char}`}
                className="splash-tagline-char"
                style={{ '--char-i': i } as React.CSSProperties}
              >
                {char === ' ' ? ' ' : char}
              </span>
            ))}
          </p>
          <span className="splash-tagline-rule splash-tagline-rule--right" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => prevProps.isReady === nextProps.isReady);
