import type { ImgHTMLAttributes } from 'react';
import clsx from 'clsx';
import { withStaticAssetStamp } from '../lib/assetUrl';

const DEFAULT_LOGO_PATH = '/TruFusionLabs_PhysicianPortal_White.png';
const BIOTECH_LOGO_PATH = '/TruFusionLabs_PhysicianPortal_White.png';

type BrandLogoImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  defaultSrc?: string;
  biotechSrc?: string;
};

export function BrandLogoImage({
  alt = 'TruFusionLabs',
  className,
  defaultSrc = DEFAULT_LOGO_PATH,
  biotechSrc = BIOTECH_LOGO_PATH,
  ...props
}: BrandLogoImageProps) {
  const sharedClassName = clsx('brand-logo-image', className);

  return (
    <>
      <img
        {...props}
        src={withStaticAssetStamp(defaultSrc)}
        alt={alt}
        className={clsx(sharedClassName, 'brand-logo-image--default')}
      />
      <img
        {...props}
        src={withStaticAssetStamp(biotechSrc)}
        alt=""
        aria-hidden="true"
        className={clsx(sharedClassName, 'brand-logo-image--biotech')}
      />
    </>
  );
}
