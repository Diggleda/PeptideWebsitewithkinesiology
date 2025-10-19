import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react@0.487.0';

type LegalDocumentKey = 'terms' | 'privacy' | 'shipping';

interface LegalSection {
  heading: string;
  body: string[];
}

const LEGAL_DOCUMENTS: Record<LegalDocumentKey, { title: string; sections: LegalSection[] }> = {
  terms: {
    title: 'Terms of Use',
    sections: [
      {
        heading: '1. Overview',
        body: [
          'These Terms of Use ("Terms") govern access to and use of the Protixa website, related mobile experiences, and any connected sales channels (collectively, the "Services"). Protixa ("we," "us," or "our") offers research-grade peptides, ancillary supplies, and educational content.',
        ],
      },
      {
        heading: '2. Acceptance of Terms',
        body: [
          'By visiting or transacting through the Services, you agree to comply with these Terms and all applicable laws. If you do not agree, discontinue use immediately.',
        ],
      },
      {
        heading: '3. Eligibility',
        body: [
          'The Services are intended for individuals at least 18 years of age who are legally able to enter binding contracts and located in jurisdictions where our products are permitted. You are solely responsible for ensuring compliance with local regulations.',
        ],
      },
      {
        heading: '4. Account Registration',
        body: [
          'Browsing may be available without registration, but certain features require an account. Provide accurate information, protect your password, and notify Protixa promptly of unauthorized use. We may suspend or close accounts at our discretion.',
        ],
      },
      {
        heading: '5. Research Use Only',
        body: [
          'Protixa products are sold strictly for laboratory, educational, or research purposes. They are not approved by the FDA for diagnostic or therapeutic use in humans or animals. You agree not to administer, sell, or distribute products for medical use and acknowledge that misuse may violate law.',
        ],
      },
      {
        heading: '6. Ordering and Payment',
        body: [
          'When placing an order, you affirm that the information provided is complete and correct and that you are authorized to use the selected payment method. Orders are subject to acceptance and availability. We may reject or cancel orders for any reason, including suspected fraud or regulatory concerns.',
        ],
      },
      {
        heading: '7. Pricing and Promotions',
        body: [
          'Prices are displayed in U.S. dollars unless noted otherwise and may change without notice. Discounts or promotional offers can carry additional conditions and may be modified or withdrawn at Protixa’s discretion.',
        ],
      },
      {
        heading: '8. Taxes',
        body: [
          'You are responsible for any sales, use, value-added, or comparable taxes arising from purchases. Where required, Protixa collects applicable taxes at checkout.',
        ],
      },
      {
        heading: '9. Shipping and Delivery',
        body: [
          'Processing and transit timelines appear in the Protixa Shipping Policy. Title and risk of loss transfer upon delivery to the carrier. Inspect shipments promptly and report damage or shortages within five days.',
        ],
      },
      {
        heading: '10. Returns and Refunds',
        body: [
          'Returns are handled according to the Shipping Policy. Protixa does not accept returns for products that are opened, tampered with, or otherwise ineligible due to safety or regulatory constraints.',
        ],
      },
      {
        heading: '11. User Conduct',
        body: [
          'You agree not to engage in unlawful, fraudulent, or abusive activity; attempt to access secured areas without authorization; harvest data; or infringe third-party rights while using the Services.',
        ],
      },
      {
        heading: '12. Intellectual Property',
        body: [
          'All content, trademarks, logos, and service marks displayed in the Services belong to Protixa or its licensors. Except for the limited license to view and purchase products, no intellectual property rights transfer to you.',
        ],
      },
      {
        heading: '13. Third-Party Links',
        body: [
          'The Services may reference third-party websites or tools. Protixa is not responsible for their content or practices. Use third-party resources at your own risk.',
        ],
      },
      {
        heading: '14. Medical Disclaimer',
        body: [
          'Scientific or educational content shared by Protixa is informational only and does not constitute medical advice. Consult qualified professionals regarding health, medical, or veterinary decisions.',
        ],
      },
      {
        heading: '15. Disclaimer of Warranties',
        body: [
          'The Services and products are provided "as is" and "as available." Protixa disclaims all warranties, express or implied, including merchantability, fitness for a particular purpose, title, and non-infringement.',
        ],
      },
      {
        heading: '16. Limitation of Liability',
        body: [
          'To the fullest extent permitted by law, Protixa and its affiliates are not liable for indirect, incidental, consequential, special, exemplary, or punitive damages. Protixa’s total liability shall not exceed the amount paid for the product giving rise to the claim.',
        ],
      },
      {
        heading: '17. Indemnification',
        body: [
          'You agree to indemnify and hold Protixa harmless from claims, losses, liabilities, and expenses (including attorneys’ fees) arising from misuse of the Services or violation of these Terms.',
        ],
      },
      {
        heading: '18. Governing Law and Dispute Resolution',
        body: [
          'These Terms are governed by U.S. law and, where applicable, the laws of the state in which Protixa is incorporated, without regard to conflict-of-laws principles. Disputes will be resolved through binding arbitration or courts in that state unless mandatory law dictates otherwise.',
        ],
      },
      {
        heading: '19. Changes to the Terms',
        body: [
          'Protixa may update these Terms at any time. Changes take effect when posted. Continued use of the Services after updates constitutes acceptance.',
        ],
      },
      {
        heading: '20. Contact',
        body: [
          'Direct questions to legal@protixa.com or mail Protixa Legal, [Insert Physical Address]. Update this contact information with your actual details.',
        ],
      },
    ],
  },
  privacy: {
    title: 'Privacy Policy',
    sections: [
      {
        heading: '1. Overview',
        body: [
          'This Privacy Policy explains how Protixa collects, uses, shares, and protects personal information obtained through our website, mobile experiences, and customer support channels (collectively, the "Services").',
        ],
      },
      {
        heading: '2. Information We Collect',
        body: [
          'Information you provide: account details, order information, payment data, communications, and form submissions.',
          'Automatically collected data: device identifiers, IP address, browser and operating system details, referring URLs, pages viewed, and on-site actions.',
          'Information from partners: fraud-prevention providers, payment processors, fulfillment vendors, and marketing partners may supply supplemental data connected to your transactions or preferences.',
        ],
      },
      {
        heading: '3. How We Use Information',
        body: [
          'Process orders, manage accounts, and deliver customer support.',
          'Communicate updates, respond to inquiries, and send transactional notices.',
          'Personalize experiences, perform analytics, improve products, and conduct quality assurance.',
          'Detect, investigate, and prevent fraud, abuse, or illegal activity.',
          'Comply with legal obligations and enforce Protixa policies.',
        ],
      },
      {
        heading: '4. Sharing of Information',
        body: [
          'Service providers: logistics partners, payment processors, IT and security vendors, marketing platforms, and professional advisors access data as needed to support Protixa.',
          'Legal requirements: information may be disclosed to satisfy legal obligations or protect Protixa, customers, or others from harm.',
          'Business transfers: in mergers, acquisitions, financings, or sales of assets, customer information may transition to the successor subject to this Policy.',
          'With your consent: data may be shared with other parties when you request or authorize it.',
        ],
      },
      {
        heading: '5. Cookies and Tracking',
        body: [
          'Protixa uses cookies, pixel tags, and similar technologies to recognize browsers, remember preferences, measure campaign performance, and analyze usage. You may refuse cookies, but some features may not function properly.',
        ],
      },
      {
        heading: '6. Advertising',
        body: [
          'We may partner with advertising networks that rely on cookies or device identifiers to deliver interest-based ads. Opt-out options are available through the Digital Advertising Alliance, Network Advertising Initiative, or device settings.',
        ],
      },
      {
        heading: '7. Data Retention',
        body: [
          'Personal information is retained as long as necessary to provide the Services, meet legal obligations, resolve disputes, and enforce agreements. Retention periods vary by data category and regulation.',
        ],
      },
      {
        heading: '8. Security',
        body: [
          'Protixa implements administrative, technical, and physical safeguards designed to protect personal information. No method of transmission or storage is entirely secure; you provide information at your own risk.',
        ],
      },
      {
        heading: '9. International Transfers',
        body: [
          'Protixa operates in the United States and may transfer information to jurisdictions with different data-protection laws. Safeguards such as contractual clauses or certification frameworks are applied when required.',
        ],
      },
      {
        heading: '10. Your Choices',
        body: [
          'Update account details, adjust marketing preferences, or request deletion by contacting privacy@protixa.com. Depending on jurisdiction, you may access, correct, delete, or restrict processing and withdraw consent.',
        ],
      },
      {
        heading: '11. California and EU/UK Residents',
        body: [
          'Residents of California, the European Economic Area, the United Kingdom, or other regions with specific privacy rights may request copies of their data, opt out of certain processing, or file complaints with supervisory authorities. Protixa responds to verifiable requests within legally mandated timelines.',
        ],
      },
      {
        heading: '12. Children’s Privacy',
        body: [
          'The Services are not directed to children under 13 (or the applicable minimum age). Protixa does not knowingly collect personal information from children and will delete such information if discovered.',
        ],
      },
      {
        heading: '13. Third-Party Services',
        body: [
          'Links to external sites or embedded tools operate under their own privacy practices. Review third-party policies before sharing personal information. Protixa is not responsible for their practices.',
        ],
      },
      {
        heading: '14. Changes to this Policy',
        body: [
          'Protixa may update this Privacy Policy to reflect legal or operational changes. Updates become effective when posted, and material changes may be communicated via email or prominent notice.',
        ],
      },
      {
        heading: '15. Contact',
        body: [
          'For privacy questions or requests, email privacy@protixa.com or write to Protixa Privacy, [Insert Physical Address]. Replace this placeholder with your actual business details.',
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
          'Protixa may request additional documentation, such as proof of research affiliation, to meet regulatory requirements. Orders pending verification will not ship until review is complete.',
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
          'Protixa cannot ship to P.O. boxes, APO/FPO/DPO addresses, or jurisdictions where peptides are restricted. International shipping is evaluated individually and may require customs declarations. Customers are responsible for understanding and complying with local import laws.',
        ],
      },
      {
        heading: '5. Rates and Fees',
        body: [
          'Shipping charges are calculated based on weight, destination, and the selected service level. Taxes, duties, and brokerage fees for international orders are the customer’s responsibility unless explicitly stated otherwise.',
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
          'Delays: Protixa is not liable for carrier delays caused by weather, customs inspections, or other factors beyond our control.',
          'Lost packages: Report packages marked “delivered” but not received within three business days. We will coordinate with the carrier to investigate, and resolutions are handled case by case.',
          'Damaged shipments: Inspect packages upon arrival and notify shipping@protixa.com with photos within five days to initiate a carrier claim.',
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
          'Certain products may require insulated packaging or cold packs. Protixa selects materials based on season and destination and recommends expedited shipping for temperature-sensitive orders, especially during extreme weather.',
        ],
      },
      {
        heading: '10. Order Changes and Cancellations',
        body: [
          'Contact support@protixa.com promptly to request modifications or cancellation. Once fulfillment begins, changes may not be possible.',
        ],
      },
      {
        heading: '11. Returns',
        body: [
          'Refer to the returns section in the Terms of Use for eligibility. Authorization must be obtained before shipping products back to Protixa. Unauthorized returns will be discarded and will not qualify for credit.',
        ],
      },
      {
        heading: '12. Policy Updates',
        body: [
          'Protixa may revise this Shipping Policy at any time. The effective date updates whenever changes are posted.',
        ],
      },
      {
        heading: '13. Contact',
        body: [
          'For shipping questions, email shipping@protixa.com or mail Protixa Fulfillment, [Insert Physical Address]. Replace this placeholder with your actual logistics contact information.',
        ],
      },
    ],
  },
};

export function LegalFooter() {
  const [activeDocument, setActiveDocument] = useState<LegalDocumentKey | null>(null);

  const legalLinks = useMemo(
    () => [
      { key: 'terms' as LegalDocumentKey, label: 'Terms of Use' },
      { key: 'privacy' as LegalDocumentKey, label: 'Privacy Policy' },
      { key: 'shipping' as LegalDocumentKey, label: 'Shipping Policy' },
    ],
    [],
  );

  const selectedDocument = activeDocument ? LEGAL_DOCUMENTS[activeDocument] : null;

  const handleLinkClick = (key: LegalDocumentKey) => {
    console.debug('[LegalFooter] Link clicked', { key });
    window.dispatchEvent(new Event('protixa:close-dialogs'));
    setActiveDocument(key);
  };

  const handleClose = () => {
    console.debug('[LegalFooter] Close requested', { activeDocument });
    setActiveDocument(null);
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  return (
    <>
      <footer className="relative z-10 mt-24 glass-strong">
        <div className="container mx-auto flex flex-col items-center px-4 pt-12 pb-24 text-center">
          <div className="mt-4 space-y-1 text-sm text-slate-600">
            <p>Advancing research-grade peptide access with care and compliance.</p>
            <p className="text-xs text-slate-500">© {new Date().getFullYear()} Protixa. All rights reserved.</p>
          </div>
          <nav className="mt-1 mb-6 flex flex-wrap items-center justify-center gap-4 text-sm font-medium text-[rgb(7,27,27)]">
            {legalLinks.map((link) => (
              <button
                key={link.key}
                type="button"
                className="cursor-pointer rounded-full px-4 py-2 pb-3 transform transition duration-200 hover:-translate-y-0.5 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(7,27,27,0.4)] btn-hover-lighter"
                onClick={() => handleLinkClick(link.key)}
              >
                {link.label}
              </button>
            ))}
          </nav>
        </div>
      </footer>

      {selectedDocument && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center px-3 py-4 sm:px-4">
          <div className="absolute inset-0 bg-black/50" onClick={handleClose} aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="legal-dialog-title"
            className="relative glass-strong w-full max-w-[min(520px,calc(100vw-1.5rem))] max-h-[78vh] rounded-lg border border-[var(--brand-glass-border-2)] text-left shadow-lg sm:max-w-[min(600px,calc(100vw-3rem))]"
          >
            <button
              type="button"
              onClick={handleClose}
              className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/85 text-slate-600 shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-[rgba(7,27,27,0.35)] btn-hover-lighter"
            >
              <X className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Close</span>
            </button>
            <div className="flex h-full min-h-0 flex-col">
              <header className="px-5 pt-7 pb-3 sm:px-6">
                <h2 id="legal-dialog-title" className="text-lg font-semibold text-[rgb(7,27,27)] sm:text-xl">
                  {selectedDocument.title}
                </h2>
              </header>
              <div className="flex-1 overflow-y-auto space-y-4 px-5 pb-7 pr-1.5 text-sm leading-6 text-slate-700 sm:px-6 sm:pb-9">
                {selectedDocument.sections.map((section, si) => (
                  <section key={`${section.heading}-${si}`} className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-[0.2em] text-[rgb(7,27,27)]/80">
                      {section.heading}
                    </h3>
                    {section.body.map((paragraph, pi) => (
                      <p key={`${si}-${pi}`}>{paragraph}</p>
                    ))}
                  </section>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
