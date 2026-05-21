import { useEffect } from "react";
import {
  BeakerIcon,
  EllipsisVerticalIcon,
  LockOpenIcon,
  ScaleIcon,
  ShieldCheckIcon,
  SwatchIcon,
} from "@heroicons/react/24/outline";
import { withStaticAssetStamp } from "../lib/assetUrl";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type ManufacturingStandardsModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ManufacturingStandardsModal({
  open,
  onOpenChange,
}: ManufacturingStandardsModalProps) {
  useEffect(() => {
    if (typeof document === "undefined") {
      return undefined;
    }
    const className = "manufacturing-standards-modal-open";
    document.body.classList.toggle(className, open);
    document.documentElement.classList.toggle(className, open);
    return () => {
      document.body.classList.remove(className);
      document.documentElement.classList.remove(className);
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        containerClassName="manufacturing-standards-dialog-layer fixed inset-0 flex items-stretch justify-stretch p-4"
        overlayClassName="bg-[rgba(4,14,21,0.64)] backdrop-blur-2xl"
        overlayStyle={{
          backdropFilter: "blur(24px) saturate(1.55)",
          WebkitBackdropFilter: "blur(24px) saturate(1.55)",
        }}
        className="glass-card h-[calc(100dvh-3rem)] w-full p-0 shadow-2xl sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] sm:max-w-none"
        style={{
          maxWidth: "none",
          maxHeight: "none",
          margin: 0,
          overflow: "hidden",
          backgroundColor: "rgba(248, 252, 255, 0.995)",
          borderColor: "rgba(11, 6, 121, 0.6)",
          backdropFilter: "none",
          WebkitBackdropFilter: "none",
          isolation: "isolate",
        }}
      >
        <div className="flex h-full min-h-0 flex-col px-6 pb-6 pt-8">
          <div className="mb-8 flex shrink-0 items-start gap-4 sm:mb-10">
            <DialogHeader className="min-w-0 flex-1 gap-0 text-left">
              <DialogTitle className="leading-tight">
                Manufacturing &amp; Quality Standards
              </DialogTitle>
              <DialogDescription className="leading-snug" style={{ marginTop: 0 }}>
                TrufusionLabs manufacturing, testing, delivery, and compliance standards.
              </DialogDescription>
            </DialogHeader>
            <DialogClose
              aria-label="Close manufacturing standards modal"
              className="manufacturing-standards-close dialog-close-btn ml-auto inline-flex shrink-0 items-center justify-center self-start text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
              style={{
                backgroundColor: "rgb(11, 6, 121)",
                color: "#ffffff",
                width: "38px",
                height: "38px",
                minWidth: "38px",
                minHeight: "38px",
                borderRadius: "9999px",
              }}
            >
              <span aria-hidden="true" className="text-xl leading-none text-white">
                &times;
              </span>
            </DialogClose>
          </div>
          <div className="no-scrollbar mt-2 flex-1 min-h-0 space-y-4 overflow-y-auto px-2 py-2 text-left text-sm leading-relaxed text-slate-700">
            <section
              className="manufacturing-standards-card squircle-lg space-y-2"
              style={{
                backgroundImage: `url(${withStaticAssetStamp("/leafTexture2.jpg")})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
                backgroundClip: "padding-box",
              }}
            >
              <h3
                className="flex items-center gap-2 text-base font-semibold"
                style={{ color: "#ffffff" }}
              >
                <BeakerIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span>Clinical Research-Grade Manufacturing</span>
              </h3>
              <p className="font-semibold" style={{ color: "#ffffff" }}>
                TrufusionLabs partners exclusively with FDA-registered and NSF-certified
                manufacturing facilities to ensure clinical research-grade quality and
                consistency. All peptide formulations are produced in GMP-compliant
                facilities.
              </p>
            </section>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <section className="manufacturing-standards-card squircle-lg h-full space-y-2">
                <h3 className="flex items-center gap-2 text-base font-semibold">
                  <EllipsisVerticalIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span>Vertically Integrated Production</span>
                </h3>
                <p>
                  Our formulations are manufactured in collaboration with a vertically
                  integrated peptide innovator that controls every stage from synthesis to
                  final packaging. This ensures:
                </p>
                <ul className="space-y-1">
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Complete chain-of-custody traceability</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Batch-specific Certificates of Analysis (COAs) for purity (&gt;= 99%) and sterility</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>HPLC and endotoxin testing</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Rapid scale-up and consistent results across all delivery formats (injectable, nasal spray)</span>
                  </li>
                </ul>
              </section>
              <section className="manufacturing-standards-card squircle-lg h-full space-y-2">
                <h3 className="flex items-center gap-2 text-base font-semibold">
                  <LockOpenIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span>Proprietary Delivery Technology</span>
                </h3>
                <p>
                  TrufusionLabs utilizes the{" "}
                  <img
                    src={withStaticAssetStamp("/protixa.png")}
                    alt="Protixa"
                    style={{
                      display: "inline-block",
                      height: "0.95em",
                      width: "auto",
                      verticalAlign: "-0.18em",
                    }}
                  />{" "}
                  ION System&trade;, an advanced ionic liquid delivery platform designed for
                  needle-free peptide administration. This proprietary system enhances
                  bioavailability through five mechanisms:
                </p>
                <ol className="space-y-1">
                  <li className="flex gap-2 leading-snug">
                    <span className="font-semibold text-slate-900">1.</span>
                    <span>Lipid layer modulation for superior absorption</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="font-semibold text-slate-900">2.</span>
                    <span>Dual polarity solubilization (no emulsifiers needed)</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="font-semibold text-slate-900">3.</span>
                    <span>Keratin modulation for transient micro-pathways</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="font-semibold text-slate-900">4.</span>
                    <span>Optimized molecule partitioning for deeper tissue delivery</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="font-semibold text-slate-900">5.</span>
                    <span>Cation exchange improving permeability</span>
                  </li>
                </ol>
              </section>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <section className="manufacturing-standards-card squircle-lg h-full space-y-2">
                <h3 className="flex items-center gap-2 text-base font-semibold">
                  <ShieldCheckIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span>Batch Testing &amp; COA Transparency</span>
                </h3>
                <p>
                  Each TrufusionLabs peptide is backed by a Certificate of Analysis as well as
                  third party testing to verify:
                </p>
                <ul className="space-y-1">
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Purity (&gt;= 99%)</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Sterility &amp; absence of microorganisms</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Endotoxin level &lt; 0.5 EU/mL</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Verified dosage and stability testing</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Quantitative testing</span>
                  </li>
                </ul>
              </section>
              <section className="manufacturing-standards-card squircle-lg h-full space-y-2">
                <h3 className="flex items-center gap-2 text-base font-semibold">
                  <ScaleIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                  <span>Quality Control &amp; Compliance</span>
                </h3>
                <ul className="space-y-1">
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Good Manufacturing Practice (cGMP) and ISO-aligned quality management systems</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Lot tracking and retention samples for every batch</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Stability testing for all formulations (-20 C cold chain storage)</span>
                  </li>
                  <li className="flex gap-2 leading-snug">
                    <span className="mt-1 text-slate-900">&bull;</span>
                    <span>Third-party verification of all finished materials</span>
                  </li>
                </ul>
              </section>
            </div>
            <section className="manufacturing-standards-card squircle-lg space-y-2">
              <h3 className="flex items-center gap-2 text-base font-semibold">
                <SwatchIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                <span>Formulation Expertise</span>
              </h3>
              <p>
                Every formula is designed by a cross-disciplinary team of experts in
                pharmaceutical R&amp;D, biochemistry, and regulatory compliance. From
                clinical research-grade peptides to white-label consumer products,
                TrufusionLabs bridges science and accessibility with full transparency and
                safety.
              </p>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
