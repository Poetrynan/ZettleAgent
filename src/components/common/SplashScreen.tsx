import { useEffect, useState, memo } from 'react';

const TAGLINE = 'Think · Connect · Evolve';

interface SplashScreenProps {
  progress: number;
  stage: string;
  isReady: boolean;
}

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
        <div className="splash-hero">
          <div className="splash-nodes-network">
            <svg className="splash-network-svg" viewBox="0 0 800 600" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="splash-line-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#06B6D4" stopOpacity="0.52" />
                  <stop offset="50%" stopColor="#3B82F6" stopOpacity="0.42" />
                  <stop offset="100%" stopColor="#10B981" stopOpacity="0.52" />
                </linearGradient>
                {/* Cut Z strokes under the wordmark — white=visible, black=hidden */}
                <mask id="splash-wordmark-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="800" height="600">
                  <rect width="800" height="600" fill="white" />
                  <rect x="158" y="252" width="484" height="62" rx="12" fill="black" />
                </mask>
              </defs>

              <path
                className="splash-network-path-track"
                pathLength={1}
                mask="url(#splash-wordmark-cut)"
                d="M 200 155 L 600 155 L 200 445 L 600 445"
                stroke="url(#splash-line-grad)"
                strokeWidth="4"
              />
              <path
                className="splash-network-path"
                pathLength={1}
                mask="url(#splash-wordmark-cut)"
                d="M 200 155 L 600 155 L 200 445 L 600 445"
                stroke="url(#splash-line-grad)"
                strokeWidth="2.25"
              />

              <circle cx="200" cy="155" r="7" fill="#10B981" className="splash-pulse-dot splash-dot-in" style={{ '--dot-delay': '0.5s' } as React.CSSProperties} />
              <circle cx="600" cy="155" r="7" fill="#06B6D4" className="splash-pulse-dot splash-dot-in" style={{ '--dot-delay': '0.65s' } as React.CSSProperties} />
              <circle cx="200" cy="445" r="7" fill="#06B6D4" className="splash-pulse-dot splash-dot-in" style={{ '--dot-delay': '0.85s' } as React.CSSProperties} />
              <circle cx="600" cy="445" r="7" fill="#10B981" className="splash-pulse-dot splash-dot-in" style={{ '--dot-delay': '1.0s' } as React.CSSProperties} />
            </svg>
          </div>

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
                  {char === ' ' ? '\u00a0' : char}
                </span>
              ))}
            </p>
            <span className="splash-tagline-rule splash-tagline-rule--right" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => prevProps.isReady === nextProps.isReady);
