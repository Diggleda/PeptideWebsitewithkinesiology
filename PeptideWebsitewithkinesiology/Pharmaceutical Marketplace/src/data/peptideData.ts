import { Product } from '../components/ProductCard';
import rawPeptideProducts from './peptideProducts.json';

type RawPeptide = {
  name: string;
  dosage: string;
  type: string;
  category: string;
  description: string;
  benefits: string;
  protocol: string;
};

const baseImage = (category: string) => {
  const catalog: Record<string, string> = {
    'Healing & Recovery': 'https://images.unsplash.com/photo-1579154204601-01588f351e67?auto=format&fit=crop&w=1200&q=80',
    'Growth Hormone Releasing': 'https://images.unsplash.com/photo-1576765607924-3f7b1d01da7c?auto=format&fit=crop&w=1200&q=80',
    'Longevity & Anti-Aging': 'https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=1200&q=80',
    'Libido & Sexual Support': 'https://images.unsplash.com/photo-1600880292203-757bb62b4baf?auto=format&fit=crop&w=1200&q=80',
    'Metabolic Support & Weight Loss': 'https://images.unsplash.com/photo-1558611848-73f7eb4001a1?auto=format&fit=crop&w=1200&q=80',
    'Nootropic, Mood & Anti-Anxiety': 'https://images.unsplash.com/photo-1525184697326-bf1c7e38f7d3?auto=format&fit=crop&w=1200&q=80'
  };
  return catalog[category] || 'https://images.unsplash.com/photo-1580281657529-47dcb0fb41ef?auto=format&fit=crop&w=1200&q=80';
};

const toPeptideProduct = (raw: RawPeptide, index: number): Product => ({
  id: `peptide-${index + 1}`,
  name: `${raw.name} (${raw.dosage})`,
  category: raw.category,
  price: 0,
  rating: 5,
  reviews: 0,
  image: baseImage(raw.category),
  inStock: true,
  prescription: raw.type === 'Injectables',
  dosage: raw.dosage,
  manufacturer: raw.type,
  type: raw.type,
  description: raw.description,
  benefits: raw.benefits,
  protocol: raw.protocol
});

const rawList = rawPeptideProducts as RawPeptide[];

export const peptideProducts: Product[] = rawList.map((product, idx) => toPeptideProduct(product, idx));

export const peptideCategories = Array.from(new Set(rawList.map((product) => product.category)));

export const peptideTypes = Array.from(new Set(rawList.map((product) => product.type)));
