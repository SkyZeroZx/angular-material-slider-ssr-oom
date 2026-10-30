import { Component, inject } from '@angular/core';
import { MatSliderModule } from '@angular/material/slider';
import { ActivatedRoute } from '@angular/router';

@Component({
  selector: 'price-band',
  templateUrl: './price-band.html',
  imports: [MatSliderModule],
})
export class PriceBand {
  private readonly params = inject(ActivatedRoute).snapshot.queryParamMap;

  readonly min = Number(this.params.get('min') ?? '0');
  readonly max = Number(this.params.get('max') ?? '100');
  readonly step = Number(this.params.get('step') ?? '1');
  readonly start = Number(this.params.get('start') ?? '0');
  readonly end = Number(this.params.get('end') ?? '100');
  readonly show = this.params.get('show') !== '0';
}
