import { Product } from '../components/ProductCard';
import rawPeptideProducts from './peptideProducts.json';

type RawPeptide = {
  name: string;
  dosage: string;
  type: string;
  category: string;
  description: string;
  image1?: string;
  image2?: string;
  image3?: string;
};

const imageModules = import.meta.glob('./Peptide_PNGs/*', {
  eager: true,
  import: 'default',
}) as Record<string, string>;

const imageLookup = Object.entries(imageModules).reduce<Record<string, string>>((acc, [path, value]) => {
  const fileName = path.split('/').pop();
  if (fileName) {
    const normalized = fileName.toLowerCase();
    acc[fileName] = value;
    acc[normalized] = value;
  }
  return acc;
}, {});

const resolveImages = (...candidates: Array<string | undefined>) => {
  return candidates
    .map((candidate) => {
      const trimmed = candidate?.trim();
      if (!trimmed) {
        return undefined;
      }
      const direct = imageLookup[trimmed];
      if (direct) {
        return direct;
      }
      return imageLookup[trimmed.toLowerCase()];
    })
    .filter((src): src is string => Boolean(src));
};

const createGradientImage = (start: string, end: string) => {
  const svg = [
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 600 400'>",
    "<defs>",
    "<linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>",
    `<stop offset='0%' stop-color='${start}'/>`,
    `<stop offset='100%' stop-color='${end}'/>`,
    '</linearGradient>',
    "<linearGradient id='overlay' x1='0' y1='0' x2='0' y2='1'>",
    "<stop offset='0%' stop-color='rgba(255,255,255,0.15)'/>",
    "<stop offset='100%' stop-color='rgba(0,0,0,0.25)'/>",
    '</linearGradient>',
    '</defs>',
    "<rect width='600' height='400' fill='url(%23g)'/>",
    "<rect width='600' height='400' fill='url(%23overlay)'/>",
    "<path d='M40 320 Q180 260 320 320 T600 320 V400 H0 V320 Z' fill='rgba(255,255,255,0.12)'/>",
    "<path d='M0 120 Q150 60 300 120 T600 120 V0 H0 Z' fill='rgba(255,255,255,0.1)'/>",
    '</svg>',
  ].join('');
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

const gradientCatalog: Record<string, string> = {
  'Healing & Recovery': createGradientImage('#0f766e', '#5eead4'),
  'Growth Hormone Releasing': createGradientImage('#2563eb', '#22d3ee'),
  'Longevity & Anti-Aging': createGradientImage('#8b5cf6', '#f472b6'),
  'Libido & Sexual Support': createGradientImage('#f97316', '#f43f5e'),
  'Metabolic Support & Weight Loss': createGradientImage('#16a34a', '#84cc16'),
  'Nootropic, Mood & Anti-Anxiety': createGradientImage('#6366f1', '#38bdf8'),
};

const baseImage = (category: string) =>
  gradientCatalog[category] || createGradientImage('#0f172a', '#22d3ee');

const toPeptideProduct = (raw: RawPeptide, index: number): Product => {
  const resolvedImages = resolveImages(raw.image1, raw.image2, raw.image3);
  const fallbackImage = baseImage(raw.category);
  const images = resolvedImages.length > 0 ? resolvedImages : [fallbackImage];

  return {
    id: `peptide-${index + 1}`,
    name: `${raw.name} (${raw.dosage})`,
    category: raw.category,
    price: 0,
    rating: 5,
    reviews: 0,
    image: images[0],
    images,
    inStock: true,
    prescription: raw.type === 'Injectables',
    dosage: raw.dosage,
    manufacturer: 'PepPro in San Diego, CA',
    type: raw.type,
    description: raw.description,
  };
};

const rawList = rawPeptideProducts as RawPeptide[];

export const peptideProducts: Product[] = rawList.map((product, idx) => toPeptideProduct(product, idx));

export const peptideCategories = Array.from(new Set(rawList.map((product) => product.category)));

export const peptideTypes = Array.from(new Set(rawList.map((product) => product.type)));
