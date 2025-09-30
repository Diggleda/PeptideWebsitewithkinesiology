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
    <Card className="glass-card squircle-lg shadow-lg">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5" />
            Filters
            {activeFiltersCount > 0 && (
              <Badge variant="secondary" className="squircle-sm">{activeFiltersCount}</Badge>
            )}
          </div>
          {activeFiltersCount > 0 && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear All
            </Button>
          )}
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
