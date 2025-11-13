import { useLayoutEffect, useRef } from 'react';
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
}

interface CategoryFilterProps {
  categories: string[];
  types: string[];
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  productCounts: Record<string, number>;
  typeCounts: Record<string, number>;
}

export function CategoryFilter({
  categories,
  types,
  filters,
  onFiltersChange,
  productCounts,
  typeCounts,
}: CategoryFilterProps) {
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
    });
  };

  const activeFiltersCount =
    filters.categories.length +
    filters.types.length +
    (filters.inStockOnly ? 1 : 0);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const bounceTimerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const card = cardRef.current;
    if (!card) {
      return;
    }

    const container = card.closest('.filter-sidebar-container') as HTMLElement | null;
    const section = container?.closest('.products-layout') as HTMLElement | null;

    if (!container || !section) {
      return;
    }

    let lastScrollY = window.scrollY || 0;

    const clearBounce = (node?: HTMLElement | null) => {
      const target = node ?? cardRef.current;
      if (!target) {
        return;
      }
      if (bounceTimerRef.current !== null) {
        window.clearTimeout(bounceTimerRef.current);
        bounceTimerRef.current = null;
      }
      target.style.transition = '';
      target.style.transform = '';
    };

    const resetStyles = () => {
      const props: Array<keyof CSSStyleDeclaration> = [
        'position',
        'top',
        'left',
        'right',
        'bottom',
        'width',
        'zIndex',
        'transform',
        'transition',
      ];
      props.forEach((key) => {
        try { (card.style as any)[key] = ''; } catch { /* noop */ }
      });
      clearBounce(card);
      try {
        container.style.minHeight = '';
        container.style.position = '';
        container.style.overflow = '';
      } catch {
        /* noop */
      }
      lastScrollY = window.scrollY || 0;
    };

    const getHeaderHeight = () => {
      const header = document.querySelector<HTMLElement>('[data-app-header]');
      const cssValue = getComputedStyle(document.documentElement).getPropertyValue('--app-header-height');
      const fallback = Number.parseFloat(cssValue || '112');
      return header?.getBoundingClientRect().height || fallback || 112;
    };

    const applyBounce = (node: HTMLElement, scrollDelta: number) => {
      const maxOffset = 28;
      const offset = Math.max(-maxOffset, Math.min(maxOffset, scrollDelta * 0.6));
      if (Math.abs(offset) <= 1) {
        node.style.transition = '';
        node.style.transform = 'translate3d(0, 0, 0)';
        if (bounceTimerRef.current !== null) {
          window.clearTimeout(bounceTimerRef.current);
          bounceTimerRef.current = null;
        }
        return;
      }

      node.style.transition = 'transform 180ms ease-out';
      node.style.transform = `translate3d(0, ${(-offset).toFixed(0)}px, 0)`;

      if (bounceTimerRef.current !== null) {
        window.clearTimeout(bounceTimerRef.current);
      }

      bounceTimerRef.current = window.setTimeout(() => {
        node.style.transition = 'transform 200ms ease-out';
        node.style.transform = 'translate3d(0, 0, 0)';
        bounceTimerRef.current = null;
      }, 140);
    };

    let rafId: number | null = null;

    const updatePosition = () => {
      const currentCard = cardRef.current;
      if (!currentCard) {
        return;
      }
      const currentContainer = currentCard.closest('.filter-sidebar-container') as HTMLElement | null;
      const currentSection = currentContainer?.closest('.products-layout') as HTMLElement | null;
      if (!currentContainer || !currentSection) {
        return;
      }

      const isDesktop = window.innerWidth >= 1024;
      if (!isDesktop) {
        resetStyles();
        return;
      }

      currentContainer.style.position = 'relative';
      currentContainer.style.overflow = 'visible';

      const headerOffset = getHeaderHeight() + 24; // keep card below header
      const bottomMargin = 24;
      const sectionRect = currentSection.getBoundingClientRect();
      const containerRect = currentContainer.getBoundingClientRect();
      const containerStyles = window.getComputedStyle(currentContainer);
      const paddingLeft = Number.parseFloat(containerStyles.paddingLeft || '0') || 0;
      const paddingRight = Number.parseFloat(containerStyles.paddingRight || '0') || 0;
      const horizontalPadding = paddingLeft + paddingRight;
      const cardHeight = currentCard.getBoundingClientRect().height;
      const sectionTop = window.scrollY + sectionRect.top;
      const sectionBottom = sectionTop + sectionRect.height;
      const scrollY = window.scrollY;

      const stickStart = sectionTop - headerOffset;
      const stickEnd = sectionBottom - headerOffset - cardHeight - bottomMargin;

      // If the card is taller than the section, fall back to static layout
      if (stickEnd <= stickStart) {
        resetStyles();
        currentContainer.style.position = 'relative';
        currentContainer.style.minHeight = `${Math.ceil(cardHeight)}px`;
        currentCard.style.position = 'absolute';
        currentCard.style.top = '0';
        currentCard.style.left = `${Math.round(paddingLeft)}px`;
        currentCard.style.right = 'auto';
        currentCard.style.width = `calc(100% - ${Math.round(horizontalPadding)}px)`;
        clearBounce(currentCard);
        lastScrollY = scrollY;
        return;
      }

      if (scrollY >= stickEnd) {
        const relativeTop = sectionBottom - cardHeight - bottomMargin - sectionTop;
        currentContainer.style.minHeight = `${Math.ceil(cardHeight)}px`;
        currentCard.style.position = 'absolute';
        currentCard.style.top = `${Math.max(0, Math.round(relativeTop))}px`;
        currentCard.style.left = `${Math.round(paddingLeft)}px`;
        currentCard.style.right = 'auto';
        currentCard.style.width = `calc(100% - ${Math.round(horizontalPadding)}px)`;
        currentCard.style.transform = 'none';
        clearBounce(currentCard);
        lastScrollY = scrollY;
        return;
      }

      if (scrollY >= stickStart) {
        currentContainer.style.minHeight = `${Math.ceil(cardHeight)}px`;
        currentCard.style.position = 'fixed';
        currentCard.style.top = `${Math.round(headerOffset)}px`;
        currentCard.style.left = `${Math.round(containerRect.left + paddingLeft)}px`;
        const fixedWidth = Math.max(0, Math.round(containerRect.width - horizontalPadding));
        currentCard.style.width = `${fixedWidth}px`;
        const delta = scrollY - lastScrollY;
        currentCard.style.transform = 'translate3d(0, 0, 0)';
        applyBounce(currentCard, delta);
        lastScrollY = scrollY;
        return;
      }

      resetStyles();
      clearBounce(currentCard);
      lastScrollY = scrollY;
    };

    const scheduleUpdate = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        updatePosition();
      });
    };

    scheduleUpdate();

    const scrollListener = () => scheduleUpdate();
    const resizeListener = () => scheduleUpdate();

    window.addEventListener('scroll', scrollListener, { passive: true });
    window.addEventListener('resize', resizeListener);
    window.addEventListener('orientationchange', resizeListener);

    const observers: ResizeObserver[] = [];
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(scheduleUpdate);
      ro.observe(container);
      observers.push(ro);
      const roSection = new ResizeObserver(scheduleUpdate);
      roSection.observe(section);
      observers.push(roSection);
    }

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      window.removeEventListener('scroll', scrollListener);
      window.removeEventListener('resize', resizeListener);
      window.removeEventListener('orientationchange', resizeListener);
      observers.forEach(observer => observer.disconnect());
      resetStyles();
      clearBounce(card);
    };
  }, []);

  return (
    <Card
      ref={cardRef}
      // Stick within the products layout column on large screens
      className="glass-card squircle-lg w-full lg:max-w-none border-l-4 border-l-[rgba(95,179,249,0.5)] border-t border-r border-b border-[rgba(255,255,255,0.45)] catalog-filter-card"
      style={{
        background:
          'linear-gradient(to right, rgba(95,179,249,0.08) 0%, rgba(255,255,255,0.35) 8px, rgba(255,255,255,0.35) 100%)',
        backdropFilter: 'blur(40px) saturate(1.7)',
      }}
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex items-center gap-2 truncate">
              <Filter className="w-5 h-5 flex-shrink-0" />
              <span className="font-semibold truncate">Filters</span>
            </div>
            <Badge
              variant="outline"
              className={`squircle-sm inline-flex items-center justify-center w-7 h-5 flex-shrink-0 ${
                activeFiltersCount > 0 ? '' : 'invisible'
              }`}
            >
              {activeFiltersCount || 0}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className={`${activeFiltersCount > 0 ? '' : 'opacity-0 pointer-events-none'} whitespace-nowrap text-sm px-3 py-1`}
          >
            Clear All
          </Button>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-3">
          <Label>Categories</Label>
          <div className="space-y-2">
            {categories.map((category) => (
              <div key={category} className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center space-x-2 min-w-0">
                  <Checkbox
                    id={`category-${category}`}
                    checked={filters.categories.includes(category)}
                    onCheckedChange={() => toggleCategory(category)}
                  />
                  <Label htmlFor={`category-${category}`} className="text-sm cursor-pointer break-words">
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

        <div className="space-y-3">
          <Label>Type</Label>
          <div className="space-y-2">
            {types.map((type) => (
              <div key={type} className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center space-x-2 min-w-0">
                  <Checkbox
                    id={`type-${type}`}
                    checked={filters.types.includes(type)}
                    onCheckedChange={() => toggleType(type)}
                  />
                  <Label htmlFor={`type-${type}`} className="text-sm cursor-pointer break-words">
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
      </CardContent>
    </Card>
  );
}
