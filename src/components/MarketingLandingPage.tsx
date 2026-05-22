import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import {
  Bars3BottomLeftIcon,
  BeakerIcon,
  EllipsisVerticalIcon,
  ScaleIcon,
  ShieldCheckIcon,
  SwatchIcon,
} from "@heroicons/react/24/outline";
import { X } from "lucide-react@0.487.0";
import { BrandLogoImage } from "./BrandLogoImage";

type MarketingLandingPageProps = {
  onSignIn: () => void;
  onReferralCode: () => void;
  onJoinNetwork: () => void;
  onPartnerApplication: () => void;
};

type StandardGroup = {
  title: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  body?: string;
  points?: ReactNode[];
};

const TRUFUSION_LOGO_PATH = "/FullLogo_Transparent_NoBuffer (18).png";
const TRUFUSION_PEPTIDES_ICON_PATH = "/Trufusionpeptides_icon.png";

const navLinks = [
  { label: "What we offer", href: "#platform" },
  { label: "Standards", href: "#standards" },
  { label: "Technology", href: "#technology" },
  { label: "Contact", href: "#contact" },
];

const capabilities = [
  {
    n: "01",
    title: "US-Synthesized Peptides and supplies",
    description: "Sourced for physician-led programs that need consistent access to research-focused materials.",
  },
  {
    n: "02",
    title: "3PL logistics",
    description: "Coordinated fulfillment support for storage, shipping, tracking, and delivery workflows.",
  },
  {
    n: "03",
    title: "White labeling",
    description: "Custom labeling for practices and partners building their own patient-facing experience.",
  },
  {
    n: "04",
    title: "Protocol and Research tools",
    description: "Proprietary digital tools that help you reach patients and coordinate support.",
  },
  {
    n: "05",
    title: "A dedicated network of physicians and peptide professionals",
    description: "A connected professional network with referrals, collaboration, and novel Peptide Forum educational calls.",
  },
];

const standardGroups: StandardGroup[] = [
  {
    title: "Clinical research-grade manufacturing",
    Icon: BeakerIcon,
    body: "TrufusionLabs partners exclusively with FDA-registered and NSF-certified manufacturing facilities to ensure clinical research-grade quality and consistency. All peptide formulations are produced in GMP-compliant facilities.",
  },
  {
    title: "Vertically integrated production",
    Icon: EllipsisVerticalIcon,
    body: "Our formulations are manufactured in collaboration with a vertically integrated peptide innovator that controls every stage from synthesis to final packaging. This ensures:",
    points: [
      "Complete chain-of-custody traceability",
      <>Batch-specific Certificates of Analysis (COAs) for purity ({"\u2265"} 99%) and sterility</>,
      "HPLC and endotoxin testing",
      "Rapid scale-up and consistent results across all delivery formats (injectable, nasal spray)",
    ],
  },
  {
    title: "Batch testing & COA transparency",
    Icon: ShieldCheckIcon,
    body: "Each TrufusionLabs peptide is backed by a Certificate of Analysis as well as third party testing to verify:",
    points: [
      <>Purity ({"\u2265"} 99%)</>,
      "Sterility and absence of microorganisms",
      "Endotoxin level < 0.5 EU/mL",
      "Verified dosage and stability testing",
      "Quantitative testing",
    ],
  },
  {
    title: "Quality control & compliance",
    Icon: ScaleIcon,
    points: [
      "Good Manufacturing Practice (cGMP) and ISO-aligned quality management systems",
      "Lot tracking and retention samples for every batch",
      <>Stability testing for all formulations (-20{"\u00b0"}C cold chain storage)</>,
      "Third-party verification of all finished materials",
    ],
  },
  {
    title: "Formulation expertise",
    Icon: SwatchIcon,
    body: "Every formula is designed by a cross-disciplinary team of experts in pharmaceutical R&D, biochemistry, and regulatory compliance. From clinical research-grade peptides to white-label consumer products, TrufusionLabs bridges science and accessibility with full transparency and safety.",
  },
];

const deliveryMechanisms = [
  "Lipid layer modulation for superior absorption",
  "Dual polarity solubilization (no emulsifiers needed)",
  "Keratin modulation for transient micro-pathways",
  "Optimized molecule partitioning for deeper tissue delivery",
  "Cation exchange improving permeability",
];

const SectionKicker = ({ children, dark = false }: { children: string; dark?: boolean }) => (
  <p className={`marketing-landing__kicker${dark ? " marketing-landing__kicker--dark" : ""}`}>
    {children}
  </p>
);

const PrimaryAction = ({
  children,
  onClick,
  variant = "dark",
}: {
  children: string;
  onClick: () => void;
  variant?: "dark" | "light";
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`marketing-landing__button marketing-landing__button--${variant}`}
  >
    {children}
  </button>
);

export function MarketingLandingPage({
  onSignIn,
  onReferralCode,
  onJoinNetwork,
  onPartnerApplication,
}: MarketingLandingPageProps) {
  const headerRef = useRef<HTMLElement | null>(null);
  const heroLogoRef = useRef<HTMLDivElement | null>(null);
  const [showHeaderIcon, setShowHeaderIcon] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (typeof document === "undefined") {
      return undefined;
    }

    document.documentElement.classList.add("marketing-landing-active");
    document.body.classList.add("marketing-landing-active");
    return () => {
      document.documentElement.classList.remove("marketing-landing-active");
      document.body.classList.remove("marketing-landing-active");
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let animationFrame: number | null = null;

    const updateHeaderIconVisibility = () => {
      animationFrame = null;
      const heroLogo = heroLogoRef.current;
      const header = headerRef.current;
      if (!heroLogo || !header) {
        setShowHeaderIcon(false);
        return;
      }

      const heroLogoRect = heroLogo.getBoundingClientRect();
      const headerHeight = header.offsetHeight || 64;
      const shouldShow = heroLogoRect.bottom <= headerHeight;
      setShowHeaderIcon((current) =>
        current === shouldShow ? current : shouldShow,
      );
    };

    const scheduleUpdate = () => {
      if (animationFrame !== null) {
        return;
      }
      animationFrame = window.requestAnimationFrame(updateHeaderIconVisibility);
    };

    scheduleUpdate();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined" || !isMobileMenuOpen) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsMobileMenuOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isMobileMenuOpen]);

  useEffect(() => {
    if (typeof window === "undefined" || !isMobileMenuOpen) {
      return undefined;
    }

    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => {
      if (mediaQuery.matches) {
        setIsMobileMenuOpen(false);
      }
    };

    closeOnDesktop();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", closeOnDesktop);
      return () => mediaQuery.removeEventListener("change", closeOnDesktop);
    }

    mediaQuery.addListener(closeOnDesktop);
    return () => mediaQuery.removeListener(closeOnDesktop);
  }, [isMobileMenuOpen]);

  return (
    <div
      className="marketing-landing"
      style={{
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Inter, sans-serif",
      }}
    >
      <header
        ref={headerRef}
        className={`marketing-landing__header${showHeaderIcon ? " marketing-landing__header--logo-visible" : ""}`}
      >
        <div className="marketing-landing__header-inner">
          <a
            href="#"
            className="marketing-landing__logo-link"
            aria-label="TrufusionLabs home"
            aria-hidden={!showHeaderIcon}
            tabIndex={showHeaderIcon ? undefined : -1}
          >
            <img
              src={TRUFUSION_PEPTIDES_ICON_PATH}
              alt=""
              className="marketing-landing__nav-logo"
              loading="eager"
              decoding="async"
            />
          </a>
          <div className="marketing-landing__header-right">
            <button
              type="button"
              className="marketing-landing__mobile-menu-trigger"
              aria-label={isMobileMenuOpen ? "Close navigation" : "Open navigation"}
              aria-controls="marketing-landing-mobile-menu"
              aria-expanded={isMobileMenuOpen}
              onClick={() => setIsMobileMenuOpen((current) => !current)}
            >
              <Bars3BottomLeftIcon aria-hidden="true" />
            </button>
            <nav className="marketing-landing__nav">
              {navLinks.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className="marketing-landing__nav-link"
                >
                  {link.label}
                </a>
              ))}
            </nav>
            <div className="marketing-landing__nav-actions">
              <button
                type="button"
                onClick={onSignIn}
                className="marketing-landing__text-button"
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={onJoinNetwork}
                className="marketing-landing__nav-cta"
              >
                Join network
              </button>
            </div>
          </div>
        </div>
      </header>

      <div
        id="marketing-landing-mobile-menu"
        className={`marketing-landing__mobile-menu${isMobileMenuOpen ? " is-open" : ""}`}
        aria-hidden={!isMobileMenuOpen}
      >
        <div className="marketing-landing__mobile-menu-top">
          <img
            src={TRUFUSION_PEPTIDES_ICON_PATH}
            alt=""
            className="marketing-landing__mobile-menu-logo"
            loading="eager"
            decoding="async"
          />
          <button
            type="button"
            className="marketing-landing__mobile-menu-close dialog-close-btn"
            aria-label="Close navigation"
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <X className="h-4 w-4 text-white" aria-hidden="true" />
          </button>
        </div>

        <nav className="marketing-landing__mobile-menu-list" aria-label="Mobile navigation">
          {navLinks.map((link, index) => (
            <a
              key={link.label}
              href={link.href}
              className="marketing-landing__mobile-menu-link"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              <span>{link.label}</span>
              <span className="marketing-landing__mobile-menu-number">
                {String(index + 1).padStart(2, "0")}
              </span>
            </a>
          ))}
        </nav>

        <div className="marketing-landing__mobile-menu-actions">
          <button
            type="button"
            onClick={() => {
              setIsMobileMenuOpen(false);
              onSignIn();
            }}
            className="marketing-landing__mobile-menu-secondary"
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => {
              setIsMobileMenuOpen(false);
              onJoinNetwork();
            }}
            className="marketing-landing__mobile-menu-primary"
          >
            Join network
          </button>
        </div>
      </div>

      <main>
        <section className="marketing-landing__section marketing-landing__section--hero">
          <div className="marketing-landing__section-inner">
            <div ref={heroLogoRef} className="marketing-landing__hero-logo-wrap">
              <BrandLogoImage
                alt="TrufusionLabs"
                defaultSrc={TRUFUSION_LOGO_PATH}
                biotechSrc={TRUFUSION_LOGO_PATH}
                className="marketing-landing__hero-logo"
                loading="eager"
                decoding="async"
              />
            </div>

            <SectionKicker>Our mission</SectionKicker>
            <p
              className="marketing-landing__mission"
            >
              To promote{" "}
              <span> endogenous healing</span>{" "}
              through a community of practitioners who work one-on-one, day in and
              day out, improving individual health across all aspects of healing.
            </p>

            <p className="marketing-landing__body marketing-landing__hero-copy">
              In addition to our US-Synthesized Peptides, TrufusionLabs offers 3PL logistics,
              white labeling, software tools for research, and a growing physician network
              across the US.
            </p>

            <div className="marketing-landing__actions">
              <PrimaryAction onClick={onJoinNetwork}>Join physician network</PrimaryAction>
              <button
                type="button"
                onClick={onReferralCode}
                className="marketing-landing__text-button marketing-landing__text-button--large"
              >
                I already have a referral code
              </button>
            </div>
          </div>
        </section>

        <section id="platform" className="marketing-landing__section marketing-landing__section--tint">
          <div className="marketing-landing__section-inner">
            <SectionKicker>What we offer</SectionKicker>
            <h2 className="marketing-landing__section-title">
              Five capabilities under one physician portal.
            </h2>

            <ul className="marketing-landing__capabilities">
              {capabilities.map((capability) => (
                <li
                  key={capability.n}
                  className="marketing-landing__capability"
                  tabIndex={0}
                >
                  <span className="marketing-landing__number">
                    {capability.n}
                  </span>
                  <div className="marketing-landing__capability-copy">
                    <h3 className="marketing-landing__capability-title">
                      {capability.title}
                    </h3>
                    <p>{capability.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="standards" className="marketing-landing__section">
          <div className="marketing-landing__section-inner">
            <SectionKicker>Manufacturing & quality standards</SectionKicker>
            <h2 className="marketing-landing__section-title marketing-landing__section-title--narrow">
              TrufusionLabs strives for operational excellence.
            </h2>

            <div className="marketing-landing__standards">
              {standardGroups.map((group) => (
                <article
                  key={group.title}
                  className="marketing-landing__standard"
                >
                  <div className="marketing-landing__standard-heading">
                    <span className="marketing-landing__standard-icon" aria-hidden="true">
                      <group.Icon />
                    </span>
                    <h3 className="marketing-landing__standard-title">
                      {group.title}
                    </h3>
                  </div>
                  <div className="marketing-landing__standard-body">
                    {group.body ? (
                      <p className="marketing-landing__body">
                        {group.body}
                      </p>
                    ) : null}
                    {group.points ? (
                      <ul className={`marketing-landing__points${group.body ? " marketing-landing__points--with-body" : ""}`}>
                        {group.points.map((point, pointIndex) => (
                          <li
                            key={pointIndex}
                            className="marketing-landing__point"
                          >
                            <span className="marketing-landing__point-dot" />
                            <span>{point}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="technology" className="marketing-landing__section marketing-landing__section--dark">
          <div className="marketing-landing__section-inner">
            <SectionKicker dark>Proprietary delivery technology</SectionKicker>
            <h2 className="marketing-landing__section-title marketing-landing__section-title--dark">
              The Protixa ION System{"\u2122"}
            </h2>
            <p className="marketing-landing__body marketing-landing__body--dark">
              TrufusionLabs incorporates the Protixa ION System{"\u2122"}, an advanced ionic
              liquid delivery platform designed for needle-free peptide administration. This
              proprietary system enhances bioavailability through five mechanisms:
            </p>

            <ol className="marketing-landing__mechanisms">
              {deliveryMechanisms.map((mechanism, index) => (
                <li
                  key={mechanism}
                  className="marketing-landing__mechanism"
                >
                  <span className="marketing-landing__number marketing-landing__number--dark">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <p>{mechanism}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="contact" className="marketing-landing__section">
          <div className="marketing-landing__section-inner">
            <SectionKicker>Get in touch</SectionKicker>
            <h2 className="marketing-landing__cta-title">
              Partner with TrufusionLabs.
            </h2>
            <div className="marketing-landing__actions">
              <PrimaryAction onClick={onPartnerApplication}>Apply to partner</PrimaryAction>
              <PrimaryAction onClick={onSignIn} variant="light">
                Sign in
              </PrimaryAction>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
