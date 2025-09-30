import { Product } from '../components/ProductCard';

export const mockProducts: Product[] = [
  {
    id: '1',
    name: 'Lisinopril 10mg Tablets',
    category: 'Cardiovascular',
    price: 24.99,
    originalPrice: 34.99,
    rating: 4.5,
    reviews: 128,
    image: 'https://images.unsplash.com/photo-1596522016734-8e6136fe5cfa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwcGlsbHMlMjBwaGFybWFjeXxlbnwxfHx8fDE3NTkxNDY1MzB8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: true,
    dosage: '10mg - 30 tablets',
    manufacturer: 'Accord Healthcare'
  },
  {
    id: '2',
    name: 'Metformin Extended Release 500mg',
    category: 'Diabetes',
    price: 18.50,
    originalPrice: 25.00,
    rating: 4.3,
    reviews: 94,
    image: 'https://images.unsplash.com/photo-1711265767477-924313b833c5?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwY2Fwc3VsZXMlMjBtZWRpY2F0aW9ufGVufDF8fHx8MTc1OTE2MTE5OXww&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: true,
    dosage: '500mg ER - 60 tablets',
    manufacturer: 'Teva Pharmaceuticals'
  },
  {
    id: '3',
    name: 'Amoxicillin 250mg Capsules',
    category: 'Antibiotics',
    price: 12.75,
    rating: 4.7,
    reviews: 156,
    image: 'https://images.unsplash.com/photo-1628771065117-74ccb5690668?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwcmVzY3JpcHRpb24lMjBib3R0bGUlMjBoZWFsdGhjYXJlfGVufDF8fHx8MTc1OTE2MTIxM3ww&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: true,
    dosage: '250mg - 21 capsules',
    manufacturer: 'Sandoz'
  },
  {
    id: '4',
    name: 'Ibuprofen 200mg Tablets',
    category: 'Pain Relief',
    price: 8.99,
    originalPrice: 12.99,
    rating: 4.4,
    reviews: 312,
    image: 'https://images.unsplash.com/photo-1577401132921-cb39bb0adcff?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwdGFibGV0cyUyMHBoYXJtYWN5JTIwd2hpdGV8ZW58MXx8fHwxNzU5MTYxMjI2fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: false,
    dosage: '200mg - 50 tablets',
    manufacturer: 'Generic Brand'
  },
  {
    id: '5',
    name: 'Insulin Glargine Injection',
    category: 'Diabetes',
    price: 89.99,
    originalPrice: 120.00,
    rating: 4.8,
    reviews: 67,
    image: 'https://images.unsplash.com/photo-1746017090180-ebb14a589639?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwaW5qZWN0aW9uJTIwc3lyaW5nZXxlbnwxfHx8fDE3NTkxNjIwODR8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: true,
    dosage: '100 units/mL - 3mL pen',
    manufacturer: 'Sanofi'
  },
  {
    id: '6',
    name: 'Vitamin D3 2000 IU',
    category: 'Vitamins',
    price: 15.99,
    rating: 4.2,
    reviews: 89,
    image: 'https://images.unsplash.com/photo-1624362772755-4d5843e67047?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwaGFybWFjZXV0aWNhbCUyMHZpdGFtaW5zJTIwc3VwcGxlbWVudHN8ZW58MXx8fHwxNzU5MTYxMjQ4fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: false,
    dosage: '2000 IU - 120 softgels',
    manufacturer: 'Nature Made'
  },
  {
    id: '7',
    name: 'Atorvastatin 20mg Tablets',
    category: 'Cardiovascular',
    price: 32.50,
    originalPrice: 45.00,
    rating: 4.6,
    reviews: 203,
    image: 'https://images.unsplash.com/photo-1596522016734-8e6136fe5cfa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwcGlsbHMlMjBwaGFybWFjeXxlbnwxfHx8fDE3NTkxNDY1MzB8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: false,
    prescription: true,
    dosage: '20mg - 30 tablets',
    manufacturer: 'Pfizer'
  },
  {
    id: '8',
    name: 'Omega-3 Fish Oil 1000mg',
    category: 'Vitamins',
    price: 22.99,
    rating: 4.1,
    reviews: 145,
    image: 'https://images.unsplash.com/photo-1624362772755-4d5843e67047?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwaGFybWFjZXV0aWNhbCUyMHZpdGFtaW5zJTIwc3VwcGxlbWVudHN8ZW58MXx8fHwxNzU5MTYxMjQ4fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: false,
    dosage: '1000mg - 90 softgels',
    manufacturer: 'Nordic Naturals'
  },
  {
    id: '9',
    name: 'Azithromycin 250mg Tablets',
    category: 'Antibiotics',
    price: 28.75,
    originalPrice: 39.99,
    rating: 4.4,
    reviews: 87,
    image: 'https://images.unsplash.com/photo-1596522016734-8e6136fe5cfa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwcGlsbHMlMjBwaGFybWFjeXxlbnwxfHx8fDE3NTkxNDY1MzB8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: true,
    dosage: '250mg - 6 tablets',
    manufacturer: 'Teva'
  },
  {
    id: '10',
    name: 'Acetaminophen 500mg',
    category: 'Pain Relief',
    price: 6.99,
    rating: 4.0,
    reviews: 245,
    image: 'https://images.unsplash.com/photo-1577401132921-cb39bb0adcff?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwdGFibGV0cyUyMHBoYXJtYWN5JTIwd2hpdGV8ZW58MXx8fHwxNzU5MTYxMjI2fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: false,
    dosage: '500mg - 100 tablets',
    manufacturer: 'Tylenol'
  },
  {
    id: '11',
    name: 'Multivitamin Complex',
    category: 'Vitamins',
    price: 19.99,
    originalPrice: 29.99,
    rating: 4.3,
    reviews: 156,
    image: 'https://images.unsplash.com/photo-1624362772755-4d5843e67047?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwaGFybWFjZXV0aWNhbCUyMHZpdGFtaW5zJTIwc3VwcGxlbWVudHN8ZW58MXx8fHwxNzU5MTYxMjQ4fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: false,
    dosage: 'Daily - 60 tablets',
    manufacturer: 'Centrum'
  },
  {
    id: '12',
    name: 'Levothyroxine 50mcg',
    category: 'Endocrine',
    price: 15.50,
    rating: 4.5,
    reviews: 78,
    image: 'https://images.unsplash.com/photo-1596522016734-8e6136fe5cfa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwcGlsbHMlMjBwaGFybWFjeXxlbnwxfHx8fDE3NTkxNDY1MzB8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    prescription: true,
    dosage: '50mcg - 30 tablets',
    manufacturer: 'Synthroid'
  }
];

export const categories = [
  'Cardiovascular',
  'Diabetes', 
  'Antibiotics',
  'Pain Relief',
  'Vitamins',
  'Respiratory',
  'Digestive Health',
  'Mental Health',
  'Endocrine'
];

export const generateReferralCode = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};