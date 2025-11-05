import { useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react@0.487.0';
import clsx from 'clsx';

type LegalDocumentKey = 'terms' | 'privacy' | 'shipping';

interface LegalSection {
  heading: string;
  body: string[];
}

const EMAIL_REGEX = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[A-Za-z]{2,})/gi;

function renderTextWithMailto(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  EMAIL_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = EMAIL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const email = match[0];
    nodes.push(
      <a
        key={`${keyPrefix}-mailto-${nodes.length}`}
        href={`mailto:${email}`}
        className="text-[rgb(95,179,249)] underline hover:text-[rgb(75,149,219)]"
      >
        {email}
      </a>,
    );
    lastIndex = match.index + email.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

const LEGAL_DOCUMENTS: Record<LegalDocumentKey, { title: string; sections: LegalSection[] }> = {
  terms: {
    title: 'Terms of Service',
    sections: [
      {
        heading: '1. Acceptance of Terms',
        body: [
          'Effective Date: November 1, 2025 (Last Updated: October 22, 2025).',
          'By accessing or using the PepPro website (https://peppro.net/) or purchasing any products or services from PepPro ("we," "us," "our"), you agree to be bound by these Terms of Service, the Privacy Policy, and the Liability Disclaimer. If you do not agree, do not use our website or purchase our products.',
          'PepPro may modify these Terms at any time. Continued use of the site constitutes acceptance of the revised Terms.',
        ],
      },
      {
        heading: '2. Eligibility',
        body: [
          'You represent that you are at least 18 years old, legally capable of entering binding agreements, and that any purchases are made for lawful purposes in compliance with all applicable regulations.',
        ],
      },
      {
        heading: '3. Research Use Only',
        body: [
          'All PepPro products—including peptides, genetic testing kits, and related compounds—are sold strictly for in vitro laboratory research use only.',
          'Products are not intended, produced, or authorized for human or animal consumption, diagnostic or therapeutic use, cosmetic or nutritional use, or any use beyond controlled laboratory research.',
          'By purchasing, you acknowledge and agree to these restrictions and assume full responsibility for compliance.',
        ],
      },
      {
        heading: '4. Product Information and FDA Disclaimer',
        body: [
          'Information provided on the PepPro website is for informational and educational purposes only.',
          'Products are not medicines or drugs, have not been evaluated or approved by the U.S. Food and Drug Administration (FDA), and are not intended to diagnose, treat, cure, mitigate, or prevent any disease.',
          'Always consult qualified professionals before treating any site information as medical advice.',
        ],
      },
      {
        heading: '5. "As-Is" Condition and No Warranties',
        body: [
          'All PepPro products and services are supplied "as is" and "with all faults." PepPro disclaims all express or implied warranties, including merchantability, fitness for a particular purpose, and non-infringement.',
          'PepPro does not guarantee safety, sterility, efficacy, accuracy, completeness, or uninterrupted operation of the website.',
        ],
      },
      {
        heading: '6. Assumption of Risk and Limitation of Liability',
        body: [
          'You assume full responsibility for the handling, storage, use, and disposal of PepPro products.',
          'PepPro and its affiliates are not liable for personal injury, illness, death, contamination, adverse reactions, improper use, property damage, business interruption, or data loss.',
          "PepPro's maximum liability will not exceed the total amount paid for the product in question.",
        ],
      },
      {
        heading: '7. Indemnification',
        body: [
          'You agree to indemnify, defend, and hold harmless PepPro, its affiliates, officers, directors, and employees from any claims, losses, damages, liabilities, and expenses (including attorneys\' fees) arising from misuse of products, violation of these Terms, or breach of your representations.',
        ],
      },
      {
        heading: '8. Intellectual Property',
        body: [
          'All website content—including text, graphics, logos, trademarks, and software—is the property of PepPro or its licensors. You may not copy, reproduce, modify, distribute, or create derivative works without prior written consent.',
        ],
      },
      {
        heading: '9. Ordering and Payment',
        body: [
          'Orders are subject to acceptance and availability, and prices may change without notice.',
          'PepPro may refuse or cancel orders that violate legal or ethical guidelines. Payment is processed through secure third-party gateways, and you authorize PepPro to charge the payment method you provide.',
        ],
      },
      {
        heading: '10. HIPAA and Health Data',
        body: [
          'For telehealth or prescription-related services, PepPro complies with the Health Insurance Portability and Accountability Act of 1996 (HIPAA).',
          'By signing the HIPAA consent form during checkout or registration, you authorize PepPro to use or disclose your Protected Health Information (PHI) for treatment, payment, and healthcare operations as described in the Notice of Privacy Practices.',
          'You may revoke consent in writing at any time by contacting support@peppro.net.',
        ],
      },
      {
        heading: '11. Compliance and Misuse',
        body: [
          'You represent and warrant that you are trained and equipped to handle research-grade materials safely, will comply with all applicable laws and regulations, and will not use PepPro products for any prohibited or unlawful purpose.',
          'PepPro may terminate purchasing rights and pursue legal remedies if misuse or non-compliance is suspected.',
        ],
      },
      {
        heading: '12. No Professional or Medical Advice',
        body: [
          'PepPro does not provide medical, legal, or professional advice. Information provided through the site is for research and informational purposes only and is not a substitute for professional judgment or treatment.',
        ],
      },
      {
        heading: '13. Governing Law and Dispute Resolution',
        body: [
          'These Terms are governed by the laws of the State of [Insert State], without regard to conflict-of-law principles.',
          'Any dispute arising from these Terms will be resolved through binding arbitration in [Insert State/County], following the rules of the American Arbitration Association (AAA).',
        ],
      },
      {
        heading: '14. Termination',
        body: [
          'PepPro may suspend or terminate access for violations of these Terms, suspected misuse, or legal non-compliance. Termination does not affect obligations or liabilities that arose prior to termination.',
        ],
      },
      {
        heading: '15. Changes to Terms',
        body: [
          'PepPro may update these Terms at any time. Changes take effect when posted on the website, and continued use constitutes acceptance of the revised Terms.',
        ],
      },
      {
        heading: '16. Contact Information',
        body: [
          'Email: support@peppro.net'
        ],
      },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    sections: [
      {
        heading: '1. Introduction',
        body: [
          'Effective Date: November 1, 2025 (Last Updated: October 22, 2025).',
          'PepPro ("we," "us," "our") respects your privacy and is committed to protecting your personal and health information. This Privacy Policy explains how we collect, use, and safeguard information through our website [insert domain], applications, and services.',
          'By using our website or purchasing from PepPro, you consent to this Policy as well as the related Disclaimer of Liability and HIPAA Consent and Notice of Privacy Practices.',
        ],
      },
      {
        heading: '2. Research-Only Product Disclaimer',
        body: [
          'All PepPro products, including peptides and genetic testing kits, are for laboratory research use only.',
          'Products are not intended, produced, or authorized for human or animal consumption, diagnostic or therapeutic use, or cosmetic, nutritional, or clinical applications.',
          'PepPro products are not medicines or drugs and have not been evaluated or approved by the U.S. Food and Drug Administration (FDA) to diagnose, treat, cure, or prevent any disease.',
          'By purchasing from PepPro, you agree to use these materials exclusively for in vitro laboratory research under appropriate safety conditions.',
        ],
      },
      {
        heading: '3. Information We Collect',
        body: [
          'We collect information in three main categories:',
          'Personal information: name, email address, billing and shipping address, phone number, payment details, and account credentials.',
          'Usage data: browser type, device identifiers, IP address, referral URLs, pages visited, and timestamps gathered through cookies or analytics tools.',
          'Protected health information (PHI): when you use PepPro telehealth or prescription-related services, we may collect PHI as defined under HIPAA.',
        ],
      },
      {
        heading: '4. How We Use Information',
        body: [
          'Order fulfillment and payment processing.',
          'Account management, communication, and customer support.',
          'Legal compliance, including HIPAA, FDA, FTC, or state requirements.',
          'Improving products and services as well as coordinating healthcare for telehealth users.',
          'PepPro does not sell or rent personal information or PHI.',
        ],
      },
      {
        heading: '5. HIPAA Compliance and Health Information',
        body: [
          'When applicable, PepPro follows HIPAA standards to protect your health information.',
          'Treatment: coordination and management of care by licensed healthcare providers.',
          'Payment: billing, claims, and pharmacy fulfillment.',
          'Healthcare operations: quality review, compliance, training, and administrative purposes.',
          'You may request restrictions on PHI use, obtain copies of records, or revoke consent in writing at any time (revocation does not affect prior disclosures). To exercise these rights, contact support@peppro.net.',
        ],
      },
      {
        heading: '6. Liability and Assumption of Risk',
        body: [
          'All PepPro products are provided "as is" and "with all faults." PepPro disclaims all express or implied warranties, including merchantability or fitness for a particular purpose.',
          'By purchasing, you accept full responsibility for handling, storage, and disposal; acknowledge PepPro is not liable for injury, contamination, or adverse events; and agree to indemnify PepPro and its affiliates against claims arising from misuse or unauthorized application.',
          "PepPro's total liability will not exceed the purchase price paid for the product.",
        ],
      },
      {
        heading: '7. Cookies and Tracking',
        body: [
          'PepPro uses cookies, pixels, and analytics tools to improve site performance, measure engagement, and personalize content. Disabling cookies may limit certain site features.',
        ],
      },
      {
        heading: '8. Your Data Rights',
        body: [
          'Depending on your jurisdiction, you may have the right to access, correct, delete, restrict processing, or object to the processing of your personal information.',
          'You may opt out of targeted advertising or data "sales" where state law (such as the CCPA) provides that right and withdraw consent where applicable.',
          'Submit privacy requests to privacy@peppro.net.',
        ],
      },
      {
        heading: '9. Data Retention and Security',
        body: [
          'PepPro retains data only as long as necessary for the purposes described in this Policy.',
          'Administrative, technical, and physical safeguards are used to help prevent unauthorized access, alteration, or loss of information; however, no online method is completely secure.',
        ],
      },
      {
        heading: '10. International Users',
        body: [
          'If you access PepPro services from outside the United States, you consent to the transfer and processing of your data in the U.S., which may have different data protection laws than your home jurisdiction.',
        ],
      },
      {
        heading: "11. Children's Privacy",
        body: [
          'PepPro services are not intended for children under 13. We do not knowingly collect personal information from minors and will delete such data promptly if discovered.',
        ],
      },
      {
        heading: '12. Updates to this Policy',
        body: [
          'PepPro may revise this Privacy Policy periodically. Changes take effect when posted, and continued use of the website constitutes acceptance of the updated terms.',
        ],
      },
      {
        heading: '13. Contact Information',
        body: [
          'Email: support@peppro.net'
        ],
      },
    ],
  },
  shipping: {
    title: 'Shipping Policy',
    sections: [
      {
        heading: '1. Order Processing',
        body: [
          'Orders are reviewed on business days (Monday through Friday, excluding federal holidays). Most in-stock items ship within one to two business days. Orders placed after 1:00 p.m. local fulfillment time may process the next business day.',
        ],
      },
      {
        heading: '2. Verification',
        body: [
          'PepPro may request additional documentation, such as proof of research affiliation, to meet regulatory requirements. Orders pending verification will not ship until review is complete.',
        ],
      },
      {
        heading: '3. Shipping Methods',
        body: [
          'Standard, expedited, and overnight services are available to most U.S. addresses. Delivery timelines begin once an order leaves our facility. Estimated transit windows provided at checkout are not guaranteed.',
        ],
      },
      {
        heading: '4. Shipping Restrictions',
        body: [
          'PepPro cannot ship to P.O. boxes, APO/FPO/DPO addresses, or jurisdictions where peptides are restricted. International shipping is evaluated individually and may require customs declarations. Customers are responsible for understanding and complying with local import laws.',
        ],
      },
      {
        heading: '5. Rates and Fees',
        body: [
          "Shipping charges are calculated based on weight, destination, and the selected service level. Taxes, duties, and brokerage fees for international orders are the customer's responsibility unless explicitly stated otherwise.",
        ],
      },
      {
        heading: '6. Tracking',
        body: [
          'A shipment confirmation email with tracking details is sent when orders depart our facility. Tracking updates originate from the carrier and may take up to 24 hours to activate.',
        ],
      },
      {
        heading: '7. Delivery Issues',
        body: [
          'Delays: PepPro is not liable for carrier delays caused by weather, customs inspections, or other factors beyond our control.',
          'Lost packages: Report packages marked "delivered" but not received within three business days. We will coordinate with the carrier to investigate, and resolutions are handled case by case.',
          'Damaged shipments: Inspect packages upon arrival and notify shipping@peppro.com with photos within five days to initiate a carrier claim.',
        ],
      },
      {
        heading: '8. Address Accuracy',
        body: [
          'Ensure the shipping address is complete and accurate. Orders returned due to incorrect or undeliverable addresses may incur reshipment fees.',
        ],
      },
      {
        heading: '9. Temperature-Sensitive Items',
        body: [
          'Certain products may require insulated packaging or cold packs. PepPro selects materials based on season and destination and recommends expedited shipping for temperature-sensitive orders, especially during extreme weather.',
        ],
      },
      {
        heading: '10. Order Changes and Cancellations',
        body: [
          'Contact support@peppro.com promptly to request modifications or cancellation. Once fulfillment begins, changes may not be possible.',
        ],
      },
      {
        heading: '11. Returns',
        body: [
          'Refer to the returns section in the Terms of Service for eligibility. Authorization must be obtained before shipping products back to PepPro. Unauthorized returns will be discarded and will not qualify for credit.',
        ],
      },
      {
        heading: '12. Policy Updates',
        body: [
          'PepPro may revise this Shipping Policy at any time. The effective date updates whenever changes are posted.',
        ],
      },
      {
        heading: '13. Contact',
        body: [
          'For shipping questions, email support@peppro.net',
        ],
      },
    ],
  },
};

export function LegalFooter() {
  const [activeDocument, setActiveDocument] = useState<LegalDocumentKey | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedDocument = activeDocument ? LEGAL_DOCUMENTS[activeDocument] : null;

  useEffect(() => {
    const body = document.body;
    const docEl = document.documentElement;
    const originalOverflow = body.style.overflow;
    const originalPaddingRight = body.style.paddingRight;

    if (activeDocument && !isClosing) {
      const scrollbarWidth = window.innerWidth - docEl.clientWidth;
      if (!originalPaddingRight && scrollbarWidth > 0) {
        body.style.paddingRight = `${scrollbarWidth}px`;
      }
      body.style.overflow = 'hidden';
      return () => {
        body.style.overflow = originalOverflow;
        body.style.paddingRight = originalPaddingRight;
      };
    }

    body.style.overflow = originalOverflow;
    body.style.paddingRight = originalPaddingRight;
    return undefined;
  }, [activeDocument, isClosing]);

  const legalLinks = useMemo(
    () => [
      { key: 'terms' as LegalDocumentKey, label: 'Terms of Service' },
      { key: 'privacy' as LegalDocumentKey, label: 'Privacy Policy' },
      { key: 'shipping' as LegalDocumentKey, label: 'Shipping Policy' },
    ],
    [],
  );

  const handleLinkClick = (key: LegalDocumentKey) => {
    console.debug('[LegalFooter] Link clicked', { key });
    window.dispatchEvent(new Event('peppro:close-dialogs'));
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsClosing(false);
    setIsVisible(false);
    setActiveDocument(key);
  };

  const handleClose = () => {
    console.debug('[LegalFooter] Close requested', { activeDocument });
    if (!activeDocument || isClosing) {
      return;
    }
    setIsClosing(true);
    setIsVisible(false);
    closeTimerRef.current = setTimeout(() => {
      setActiveDocument(null);
      setIsClosing(false);
      closeTimerRef.current = null;
    }, 180);
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  useEffect(() => {
    if (selectedDocument && !isClosing) {
      const raf = requestAnimationFrame(() => setIsVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    if (!selectedDocument && !isClosing && isVisible) {
      setIsVisible(false);
    }
    return undefined;
  }, [selectedDocument, isClosing, isVisible]);

  useEffect(() => () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }
  }, []);

  const shouldBlurBackground = isVisible || isClosing;

  return (
    <>
      <footer className="relative z-10 mt-24 glass-strong">
        <div className="w-full px-2 pt-16 pb-12">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-center">
            {/* Disclaimer - Left Third */}
            <div className="text-justify flex items-center">
              <p className="text-xs text-slate-500 leading-relaxed">
                PepPro peptide products are research chemicals intended for licensed physicians only. They are not intended to prevent, treat, or cure any medical condition, ailment or disease. These products have not been reviewed or approved by the US Food and Drug Administration.
              </p>
            </div>

            {/* Center Content - Middle Third */}
            <div className="flex flex-col items-center text-center">
              <div className="space-y-1 text-sm text-slate-600">
                <p>Advancing research-grade peptide access with care and compliance.</p>
                <p className="text-xs text-slate-500">© {new Date().getFullYear()} PepPro. All rights reserved.</p>
              </div>
              <nav className="mt-1 mb-1 flex flex-wrap items-center justify-center gap-4 text-sm font-medium text-[rgb(95,179,249)]">
                {legalLinks.map((link) => (
                  <button
                    key={link.key}
                    type="button"
                    className="cursor-pointer rounded-full px-4 py-2 pb-3 transform transition duration-200 hover:-translate-y-0.5 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(95,179,249,0.4)] btn-hover-lighter"
                    onClick={() => handleLinkClick(link.key)}
                  >
                    {link.label}
                  </button>
                ))}
              </nav>
            </div>

            {/* Empty Right Third */}
            <div></div>
          </div>
        </div>
      </footer>

      {selectedDocument && createPortal(
        <div
          className={clsx(
            'fixed inset-0 flex items-center justify-center p-6 sm:p-12 transition-opacity duration-200 ease-out backdrop-blur-[16px]',
            isVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
          )}
          style={{
            zIndex: 2147483647,
            position: 'fixed',
            willChange: 'opacity',
            backdropFilter: shouldBlurBackground ? 'blur(16px)' : 'none',
            WebkitBackdropFilter: shouldBlurBackground ? 'blur(16px)' : 'none',
          }}
        >
          <div
            className={clsx(
              'absolute inset-0 bg-[rgba(4,14,21,0.55)] transition-opacity duration-200 ease-out',
              isVisible ? 'opacity-100' : 'opacity-0',
            )}
            onClick={handleClose}
            aria-hidden="true"
            style={{
              willChange: 'opacity',
              backdropFilter: shouldBlurBackground ? 'blur(20px) saturate(1.55)' : 'none',
              WebkitBackdropFilter: shouldBlurBackground ? 'blur(20px) saturate(1.55)' : 'none',
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="legal-dialog-title"
            className={clsx(
              'relative w-full max-w-3xl flex flex-col transition-[opacity,transform] duration-200 ease-out h-full',
              isVisible ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-4 scale-[0.97]',
            )}
            style={{ willChange: 'opacity, transform', maxHeight: 'calc(100vh - 4rem)' }}
          >
            <div
              className="squircle-xl glass-card landing-glass shadow-[0_24px_60px_-25px_rgba(7,27,27,0.55)] h-full flex flex-col overflow-hidden border-[3px]"
              style={{
                backgroundColor: 'rgba(245, 251, 255, 0.94)',
                borderColor: 'rgba(95, 179, 249, 0.65)',
                backdropFilter: shouldBlurBackground ? 'blur(16px) saturate(1.45)' : 'none',
                WebkitBackdropFilter: shouldBlurBackground ? 'blur(16px) saturate(1.45)' : 'none',
              }}
            >
              <div className="flex items-center justify-between gap-4 px-6 sm:px-8 py-5 flex-shrink-0 border-b" style={{ borderColor: 'rgba(95, 179, 249, 0.2)', backgroundColor: 'rgb(255, 255, 255)' }}>
                <h2 id="legal-dialog-title" className="flex-1 text-xl sm:text-2xl font-semibold text-[rgb(95,179,249)] pr-2">
                  {selectedDocument.title}
                </h2>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClose();
                  }}
                  className="legal-modal-close-btn inline-flex items-center justify-center text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-[3px] focus-visible:ring-offset-[rgba(4,14,21,0.75)] transition-all duration-150"
                  style={{ backgroundColor: 'rgb(95, 179, 249)', width: '38px', height: '38px', borderRadius: '50%', marginTop: '6px', marginBottom: '6px' }}
                >
                  <X className="h-4 w-4 sm:h-5 sm:w-5" aria-hidden="true" />
                  <span className="sr-only">Close</span>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-6 sm:px-8 py-8">
                {selectedDocument.sections.map((section, si) => (
                  <section
                    key={`${section.heading}-${si}`}
                    className={clsx(si > 0 ? 'mt-6' : undefined)}
                  >
                    <h3
                      className="text-sm font-semibold uppercase tracking-wide text-[rgb(95,179,249)]"
                      style={{ margin: 0 }}
                    >
                      {section.heading}
                    </h3>
                    {section.body.map((paragraph, bi) => (
                      <p
                        key={`${section.heading}-${si}-${bi}`}
                        className="text-sm leading-relaxed text-slate-700"
                        style={{ margin: 0, marginTop: bi === 0 ? 0 : '0.75rem' }}
                      >
                        {renderTextWithMailto(paragraph, `${si}-${bi}`)}
                      </p>
                    ))}
                  </section>
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
