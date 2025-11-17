import { Product } from '../components/ProductCard';

export const mockProducts: Product[] = [
  {
    id: '1',
    name: 'Lisinopril Tablets',
    category: 'Cardiovascular',
    image: 'https://images.unsplash.com/photo-1596522016734-8e6136fe5cfa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwcGlsbHMlMjBwaGFybWFjeXxlbnwxfHx8fDE3NTkxNDY1MzB8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Accord Healthcare',
    variations: [
      { id: 'var-1-10mg', strength: '10mg - 30 tablets', basePrice: 24.99 },
      { id: 'var-1-20mg', strength: '20mg - 30 tablets', basePrice: 32.99 },
      { id: 'var-1-40mg', strength: '40mg - 30 tablets', basePrice: 44.99 }
    ],
    bulkPricingTiers: [
      { minQuantity: 3, discountPercentage: 5 },
      { minQuantity: 5, discountPercentage: 10 },
      { minQuantity: 10, discountPercentage: 15 }
    ]
  },
  {
    id: '2',
    name: 'Metformin Extended Release',
    category: 'Diabetes',
    image: 'https://images.unsplash.com/photo-1711265767477-924313b833c5?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwY2Fwc3VsZXMlMjBtZWRpY2F0aW9ufGVufDF8fHx8MTc1OTE2MTE5OXww&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Teva Pharmaceuticals',
    variations: [
      { id: 'var-2-500mg', strength: '500mg ER - 60 tablets', basePrice: 18.50 },
      { id: 'var-2-750mg', strength: '750mg ER - 60 tablets', basePrice: 24.50 },
      { id: 'var-2-1000mg', strength: '1000mg ER - 60 tablets', basePrice: 32.50 }
    ],
    bulkPricingTiers: [
      { minQuantity: 2, discountPercentage: 5 },
      { minQuantity: 4, discountPercentage: 10 },
      { minQuantity: 6, discountPercentage: 15 }
    ]
  },
  {
    id: '3',
    name: 'Amoxicillin Capsules',
    category: 'Antibiotics',
    image: 'https://images.unsplash.com/photo-1628771065117-74ccb5690668?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwcmVzY3JpcHRpb24lMjBib3R0bGUlMjBoZWFsdGhjYXJlfGVufDF8fHx8MTc1OTE2MTIxM3ww&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Sandoz',
    variations: [
      { id: 'var-3-250mg', strength: '250mg - 21 capsules', basePrice: 12.75 },
      { id: 'var-3-500mg', strength: '500mg - 21 capsules', basePrice: 18.75 }
    ],
    bulkPricingTiers: [
      { minQuantity: 3, discountPercentage: 8 },
      { minQuantity: 6, discountPercentage: 12 }
    ]
  },
  {
    id: '4',
    name: 'Ibuprofen Tablets',
    category: 'Pain Relief',
    image: 'https://images.unsplash.com/photo-1577401132921-cb39bb0adcff?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwdGFibGV0cyUyMHBoYXJtYWN5JTIwd2hpdGV8ZW58MXx8fHwxNzU5MTYxMjI2fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Generic Brand',
    variations: [
      { id: 'var-4-200mg', strength: '200mg - 50 tablets', basePrice: 8.99 },
      { id: 'var-4-400mg', strength: '400mg - 50 tablets', basePrice: 13.99 },
      { id: 'var-4-600mg', strength: '600mg - 50 tablets', basePrice: 17.99 }
    ],
    bulkPricingTiers: [
      { minQuantity: 3, discountPercentage: 10 },
      { minQuantity: 5, discountPercentage: 15 },
      { minQuantity: 10, discountPercentage: 20 }
    ]
  },
  {
    id: '5',
    name: 'Insulin Glargine Injection',
    category: 'Diabetes',
    image: 'https://images.unsplash.com/photo-1746017090180-ebb14a589639?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwaW5qZWN0aW9uJTIwc3lyaW5nZXxlbnwxfHx8fDE3NTkxNjIwODR8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Sanofi',
    variations: [
      { id: 'var-5-100units', strength: '100 units/mL - 3mL pen', basePrice: 89.99 },
      { id: 'var-5-100units-5pack', strength: '100 units/mL - 5 pack', basePrice: 425.00 }
    ],
    bulkPricingTiers: [
      { minQuantity: 2, discountPercentage: 5 },
      { minQuantity: 4, discountPercentage: 10 }
    ]
  },
  {
    id: '6',
    name: 'Vitamin D3',
    category: 'Vitamins',
    image: 'https://images.unsplash.com/photo-1624362772755-4d5843e67047?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwaGFybWFjZXV0aWNhbCUyMHZpdGFtaW5zJTIwc3VwcGxlbWVudHN8ZW58MXx8fHwxNzU5MTYxMjQ4fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Nature Made',
    variations: [
      { id: 'var-6-1000iu', strength: '1000 IU - 120 softgels', basePrice: 12.99 },
      { id: 'var-6-2000iu', strength: '2000 IU - 120 softgels', basePrice: 15.99 },
      { id: 'var-6-5000iu', strength: '5000 IU - 120 softgels', basePrice: 22.99 }
    ],
    bulkPricingTiers: [
      { minQuantity: 3, discountPercentage: 10 },
      { minQuantity: 6, discountPercentage: 15 },
      { minQuantity: 12, discountPercentage: 20 }
    ]
  },
  {
    id: '7',
    name: 'Atorvastatin Tablets',
    category: 'Cardiovascular',
    image: 'https://images.unsplash.com/photo-1596522016734-8e6136fe5cfa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwcGlsbHMlMjBwaGFybWFjeXxlbnwxfHx8fDE3NTkxNDY1MzB8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: false,
    manufacturer: 'Pfizer',
    variations: [
      { id: 'var-7-10mg', strength: '10mg - 30 tablets', basePrice: 24.50 },
      { id: 'var-7-20mg', strength: '20mg - 30 tablets', basePrice: 32.50 },
      { id: 'var-7-40mg', strength: '40mg - 30 tablets', basePrice: 42.50 },
      { id: 'var-7-80mg', strength: '80mg - 30 tablets', basePrice: 54.50 }
    ],
    bulkPricingTiers: [
      { minQuantity: 3, discountPercentage: 5 },
      { minQuantity: 6, discountPercentage: 12 }
    ]
  },
  {
    id: '8',
    name: 'Omega-3 Fish Oil',
    category: 'Vitamins',
    image: 'https://images.unsplash.com/photo-1624362772755-4d5843e67047?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwaGFybWFjZXV0aWNhbCUyMHZpdGFtaW5zJTIwc3VwcGxlbWVudHN8ZW58MXx8fHwxNzU5MTYxMjQ4fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Nordic Naturals',
    variations: [
      { id: 'var-8-1000mg', strength: '1000mg - 90 softgels', basePrice: 22.99 },
      { id: 'var-8-1400mg', strength: '1400mg - 90 softgels', basePrice: 32.99 }
    ],
    bulkPricingTiers: [
      { minQuantity: 3, discountPercentage: 10 },
      { minQuantity: 6, discountPercentage: 18 }
    ]
  },
  {
    id: '9',
    name: 'Azithromycin Tablets',
    category: 'Antibiotics',
    image: 'https://images.unsplash.com/photo-1596522016734-8e6136fe5cfa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwcGlsbHMlMjBwaGFybWFjeXxlbnwxfHx8fDE3NTkxNDY1MzB8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Teva',
    variations: [
      { id: 'var-9-250mg', strength: '250mg - 6 tablets', basePrice: 28.75 },
      { id: 'var-9-500mg', strength: '500mg - 3 tablets', basePrice: 32.75 }
    ],
    bulkPricingTiers: [
      { minQuantity: 2, discountPercentage: 8 },
      { minQuantity: 4, discountPercentage: 15 }
    ]
  },
  {
    id: '10',
    name: 'Acetaminophen',
    category: 'Pain Relief',
    image: 'https://images.unsplash.com/photo-1577401132921-cb39bb0adcff?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwdGFibGV0cyUyMHBoYXJtYWN5JTIwd2hpdGV8ZW58MXx8fHwxNzU5MTYxMjI2fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Tylenol',
    variations: [
      { id: 'var-10-325mg', strength: '325mg - 100 tablets', basePrice: 5.99 },
      { id: 'var-10-500mg', strength: '500mg - 100 tablets', basePrice: 6.99 },
      { id: 'var-10-650mg', strength: '650mg ER - 100 tablets', basePrice: 9.99 }
    ],
    bulkPricingTiers: [
      { minQuantity: 5, discountPercentage: 12 },
      { minQuantity: 10, discountPercentage: 20 },
      { minQuantity: 20, discountPercentage: 25 }
    ]
  },
  {
    id: '11',
    name: 'Multivitamin Complex',
    category: 'Vitamins',
    image: 'https://images.unsplash.com/photo-1624362772755-4d5843e67047?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxwaGFybWFjZXV0aWNhbCUyMHZpdGFtaW5zJTIwc3VwcGxlbWVudHN8ZW58MXx8fHwxNzU5MTYxMjQ4fDA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Centrum',
    variations: [
      { id: 'var-11-men', strength: "Men's Daily - 60 tablets", basePrice: 19.99 },
      { id: 'var-11-women', strength: "Women's Daily - 60 tablets", basePrice: 19.99 },
      { id: 'var-11-senior', strength: 'Senior 50+ - 60 tablets', basePrice: 21.99 }
    ],
    bulkPricingTiers: [
      { minQuantity: 3, discountPercentage: 10 },
      { minQuantity: 6, discountPercentage: 15 }
    ]
  },
  {
    id: '12',
    name: 'Levothyroxine',
    category: 'Endocrine',
    image: 'https://images.unsplash.com/photo-1596522016734-8e6136fe5cfa?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w3Nzg4Nzd8MHwxfHNlYXJjaHwxfHxtZWRpY2FsJTIwcGlsbHMlMjBwaGFybWFjeXxlbnwxfHx8fDE3NTkxNDY1MzB8MA&ixlib=rb-4.1.0&q=80&w=1080&utm_source=figma&utm_medium=referral',
    inStock: true,
    manufacturer: 'Synthroid',
    variations: [
      { id: 'var-12-25mcg', strength: '25mcg - 30 tablets', basePrice: 12.50 },
      { id: 'var-12-50mcg', strength: '50mcg - 30 tablets', basePrice: 15.50 },
      { id: 'var-12-75mcg', strength: '75mcg - 30 tablets', basePrice: 18.50 },
      { id: 'var-12-100mcg', strength: '100mcg - 30 tablets', basePrice: 21.50 }
    ],
    bulkPricingTiers: [
      { minQuantity: 3, discountPercentage: 8 },
      { minQuantity: 6, discountPercentage: 15 }
    ]
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
