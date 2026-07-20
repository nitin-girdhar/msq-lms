'use client';

import { MultiSelect, type SelectOption } from '@platform/ui-kit';
import type { LocationOption } from '../../hooks/useLocationFilters';
import type { DynamicOrg } from '../../hooks/useOrgs';

function toOption(o: LocationOption): SelectOption {
  return { id: o.id, label: o.name };
}

function fromOption(o: SelectOption, source: LocationOption[]): LocationOption {
  return source.find((s) => s.id === o.id) ?? { id: o.id as number, name: o.label };
}

interface Props {
  countries: LocationOption[];
  states: LocationOption[];
  cities: LocationOption[];
  selectedCountries: LocationOption[];
  selectedStates: LocationOption[];
  selectedCities: LocationOption[];
  onCountriesChange: (next: LocationOption[]) => void;
  onStatesChange: (next: LocationOption[]) => void;
  onCitiesChange: (next: LocationOption[]) => void;
  loadingCountries: boolean;
  loadingStates: boolean;
  loadingCities: boolean;
  orgs: DynamicOrg[];
  selectedOrgs: DynamicOrg[];
  onOrgsChange: (next: DynamicOrg[]) => void;
  loadingOrgs: boolean;
  leadSources: string[];
  selectedSources: string[];
  onSourcesChange: (next: string[]) => void;
  loadingSources: boolean;
}

export default function LocationFilters({
  countries, states, cities,
  selectedCountries, selectedStates, selectedCities,
  onCountriesChange, onStatesChange, onCitiesChange,
  loadingCountries, loadingStates, loadingCities,
  orgs, selectedOrgs, onOrgsChange, loadingOrgs,
  leadSources, selectedSources, onSourcesChange, loadingSources,
}: Props) {
  const orgOptions: SelectOption[]         = orgs.map((o) => ({ id: o.id, label: o.name }));
  const selectedOrgOptions: SelectOption[] = selectedOrgs.map((o) => ({ id: o.id, label: o.name }));
  const sourceOptions: SelectOption[]         = leadSources.map((s) => ({ id: s, label: s }));
  const selectedSourceOptions: SelectOption[] = selectedSources.map((s) => ({ id: s, label: s }));

  const handleOrgsChange = (next: SelectOption[]) => {
    const nextOrgs = next.map(
      (o) => orgs.find((org) => org.id === o.id) ?? { id: o.id as string, name: o.label, cityId: null, stateId: null, countryId: null },
    );
    onOrgsChange(nextOrgs);
  };

  return (
    <div className="flex shrink-0 flex-wrap items-end gap-3 border-b border-[#E2E8F0] bg-white px-4 py-2.5 sm:px-5">
      <MultiSelect
        label="Country"
        placeholder="All countries"
        options={countries.map(toOption)}
        selected={selectedCountries.map(toOption)}
        onChange={(next) => onCountriesChange(next.map((o) => fromOption(o, countries)))}
        loading={loadingCountries}
      />

      <MultiSelect
        label="State"
        placeholder={selectedCountries.length ? 'All states' : 'Select country first'}
        options={states.map(toOption)}
        selected={selectedStates.map(toOption)}
        onChange={(next) => onStatesChange(next.map((o) => fromOption(o, states)))}
        loading={loadingStates}
        disabled={selectedCountries.length === 0}
      />

      <MultiSelect
        label="City"
        placeholder={selectedStates.length ? 'All cities' : 'Select state first'}
        options={cities.map(toOption)}
        selected={selectedCities.map(toOption)}
        onChange={(next) => onCitiesChange(next.map((o) => fromOption(o, cities)))}
        loading={loadingCities}
        disabled={selectedStates.length === 0}
      />

      <MultiSelect
        label="Org"
        placeholder="All orgs"
        options={orgOptions}
        selected={selectedOrgOptions}
        onChange={handleOrgsChange}
        loading={loadingOrgs}
      />

      <MultiSelect
        label="Lead Source"
        placeholder="All sources"
        options={sourceOptions}
        selected={selectedSourceOptions}
        onChange={(next) => onSourcesChange(next.map((o) => String(o.id)))}
        loading={loadingSources}
      />
    </div>
  );
}
