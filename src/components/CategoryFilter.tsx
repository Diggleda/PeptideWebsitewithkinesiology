import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Filter } from 'lucide-react';

interface FilterState {
  categories: string[];
  types: string[];
  inStockOnly: boolean;
  prescriptionOnly: boolean;
}

interface CategoryFilterProps {
  categories: string[];
  types: string[];
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  productCounts: Record<string, number>;
  typeCounts: Record<string, number>;
}

export function CategoryFilter({ categories, types, filters, onFiltersChange, productCounts, typeCounts }: CategoryFilterProps) {
  const toggleCategory = (category: string) => {
    const categoriesSet = new Set(filters.categories);
    categoriesSet.has(category) ? categoriesSet.delete(category) : categoriesSet.add(category);
    onFiltersChange({ ...filters, categories: Array.from(categoriesSet) });
  };

  const toggleType = (type: string) => {
    const typesSet = new Set(filters.types);
    typesSet.has(type) ? typesSet.delete(type) : typesSet.add(type);
    onFiltersChange({ ...filters, types: Array.from(typesSet) });
  };

  const clearFilters = () => {
    onFiltersChange({
      categories: [],
      types: [],
      inStockOnly: false,
      prescriptionOnly: false
    });
  };

  const activeFiltersCount =
    filters.categories.length +
    filters.types.length +
    (filters.inStockOnly ? 1 : 0) +
    (filters.prescriptionOnly ? 1 : 0);

  return (
    <Card className="glass-card squircle-lg w-full lg:max-w-none border border-[var(--brand-glass-border-2)] shadow-[0_18px_48px_-28px_rgba(7,27,27,0.35)]">
      <CardHeader>
        <CardTitle className='flex items-center justify-between'>
          <div className='flex items-center gap-2 min-w-0'>
            <div className='flex items-center gap-2 truncate'>
              <Filter className='w-5 h-5 flex-shrink-0' />
              <span className='font-semibold truncate'>Filters</span>
            </div>
            <Badge
              variant='secondary'
              className={`squircle-sm inline-flex items-center justify-center w-7 h-5 flex-shrink-0 ${activeFiltersCount > 0 ? '' : 'invisible'}`}
            >
              {activeFiltersCount || 0}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className={`${activeFiltersCount > 0 ? '' : 'opacity-0 pointer-events-none'} whitespace-nowrap`}
          >
            Clear All
          </Button>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Categories */}
        <div className="space-y-3">
          <Label>Categories</Label>
          <div className="space-y-2">
            {categories.map((category) => (
              <div key={category} className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={`category-${category}`}
                    checked={filters.categories.includes(category)}
                    onCheckedChange={() => toggleCategory(category)}
                  />
                  <Label htmlFor={`category-${category}`} className="text-sm cursor-pointer">
                    {category}
                  </Label>
                </div>
                <Badge variant="outline" className="text-xs squircle-sm">
                  {productCounts[category] || 0}
                </Badge>
              </div>
            ))}
          </div>
        </div>

        {/* Types */}
        <div className="space-y-3">
          <Label>Type</Label>
          <div className="space-y-2">
            {types.map((type) => (
              <div key={type} className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={`type-${type}`}
                    checked={filters.types.includes(type)}
                    onCheckedChange={() => toggleType(type)}
                  />
                  <Label htmlFor={`type-${type}`} className="text-sm cursor-pointer">
                    {type}
                  </Label>
                </div>
                <Badge variant="outline" className="text-xs squircle-sm">
                  {typeCounts[type] || 0}
                </Badge>
              </div>
            ))}
          </div>
        </div>

        {/* Availability */}
        <div className="space-y-3">
          <Label>Availability</Label>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="inStock"
              checked={filters.inStockOnly}
              onCheckedChange={(checked) => onFiltersChange({ ...filters, inStockOnly: !!checked })}
            />
            <Label htmlFor="inStock" className="text-sm cursor-pointer">
              In Stock Only
            </Label>
          </div>
        </div>

        {/* Prescription */}
        <div className="space-y-3">
          <Label>Prescription</Label>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="prescription"
              checked={filters.prescriptionOnly}
              onCheckedChange={(checked) => onFiltersChange({ ...filters, prescriptionOnly: !!checked })}
            />
            <Label htmlFor="prescription" className="text-sm cursor-pointer">
              Prescription Only
            </Label>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
