import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Checkbox } from './ui/checkbox';
import { Slider } from './ui/slider';
import { Label } from './ui/label';
import { Filter } from 'lucide-react';

interface FilterState {
  categories: string[];
  priceRange: [number, number];
  prescriptionOnly: boolean;
  rating: number;
}

interface CategoryFilterProps {
  categories: string[];
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  productCounts: Record<string, number>;
}

export function CategoryFilter({ categories, filters, onFiltersChange, productCounts }: CategoryFilterProps) {
  const handleCategoryToggle = (category: string) => {
    const newCategories = filters.categories.includes(category)
      ? filters.categories.filter(c => c !== category)
      : [...filters.categories, category];
    
    onFiltersChange({ ...filters, categories: newCategories });
  };

  const handlePriceRangeChange = (value: number[]) => {
    onFiltersChange({ ...filters, priceRange: [value[0], value[1]] });
  };

  const clearFilters = () => {
    onFiltersChange({
      categories: [],
      priceRange: [0, 500],
      prescriptionOnly: false,
      rating: 0
    });
  };

  const activeFiltersCount = 
    filters.categories.length + 
    (filters.prescriptionOnly ? 1 : 0) + 
    (filters.rating > 0 ? 1 : 0) +
    (filters.priceRange[0] > 0 || filters.priceRange[1] < 500 ? 1 : 0);

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
                    id={category}
                    checked={filters.categories.includes(category)}
                    onCheckedChange={() => handleCategoryToggle(category)}
                  />
                  <Label htmlFor={category} className="text-sm cursor-pointer">
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

        {/* Price Range */}
        <div className="space-y-3">
          <Label>Price Range</Label>
          <div className="px-2">
            <Slider
              value={filters.priceRange}
              onValueChange={handlePriceRangeChange}
              max={500}
              min={0}
              step={5}
              className="w-full"
            />
            <div className="flex justify-between text-sm text-gray-600 mt-2">
              <span>${filters.priceRange[0]}</span>
              <span>${filters.priceRange[1]}</span>
            </div>
          </div>
        </div>

        {/* Prescription */}
        <div className="space-y-3">
          <Label>Type</Label>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="prescription"
              checked={filters.prescriptionOnly}
              onCheckedChange={(checked) => 
                onFiltersChange({ ...filters, prescriptionOnly: !!checked })
              }
            />
            <Label htmlFor="prescription" className="text-sm cursor-pointer">
              Prescription Only
            </Label>
          </div>
        </div>

        {/* Rating */}
        <div className="space-y-3">
          <Label>Minimum Rating</Label>
          <div className="px-2">
            <Slider
              value={[filters.rating]}
              onValueChange={(value) => onFiltersChange({ ...filters, rating: value[0] })}
              max={5}
              min={0}
              step={0.5}
              className="w-full"
            />
            <div className="text-sm text-gray-600 mt-2">
              {filters.rating > 0 ? `${filters.rating}+ stars` : 'Any rating'}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
