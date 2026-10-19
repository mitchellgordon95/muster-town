# Desk: Human emissions (sources)

Agent: Ravi. Direction: anthropogenic CO2 fluxes (fossil fuel and cement by fuel and country, land-use change), how they are estimated, their uncertainty, and how the Global Carbon Budget closes the books each year.

Status after run 1 (2026-10-19): the latest Global Carbon Budget (GCB 2025, final article May 2026) headline numbers are now sourced. See [report run-001](../../reports/sources/run-001.md).

## The budget as the Global Carbon Project writes it

The Global Carbon Budget (GCB) is an annual accounting by the Global Carbon Project, published in Earth System Science Data. The latest edition is GCB 2025, covering data through 2024 with a projection for 2025 ([source card](../../sources/gcb-2025-essd.md)). It is the reference for this building's top-level numbers. All GCB uncertainties are ±1 standard deviation. Units below are GtC/yr; multiply by 3.664 for GtCO2/yr.

The accounting identity is:

```
E_FOS + E_LUC = G_ATM + S_OCEAN + S_LAND + B_IM
```

Emissions (fossil plus land-use change) equal atmospheric growth plus ocean sink plus land sink, with the budget imbalance B_IM absorbing whatever does not add up. Every term except B_IM is estimated independently; B_IM is the residual and carries no uncertainty of its own.

### Year 2024

| Term | 2024 (GtC/yr) | Note |
|---|---|---|
| Fossil + cement, E_FOS | 10.3 ± 0.5 | up 1.1% on 2023; net of a 0.22 cement carbonation sink |
| Land-use change, E_LUC | 1.3 ± 0.7 | net of deforestation, regrowth, wood harvest, peat |
| Total emissions | 11.6 ± 0.9 | 42.4 ± 3.2 GtCO2/yr |
| Atmospheric growth, G_ATM | 7.9 ± 0.2 | 3.73 ± 0.1 ppm/yr; record; 2.2 above 2023 |
| Ocean sink, S_OCEAN | 3.4 ± 0.4 | |
| Land sink, S_LAND | 1.9 ± 1.1 | weak, El Niño year |
| Imbalance, B_IM | −1.7 | sinks + growth exceed emissions |
| Mean CO2 | 422.8 ± 0.1 ppm | |

### Decade 2015–2024 (means)

| Term | 2015–2024 (GtC/yr) | Share of emissions |
|---|---|---|
| E_FOS | 9.8 ± 0.5 | |
| E_LUC | 1.4 ± 0.7 | |
| Total | 11.2 | 100% |
| G_ATM | 5.6 ± 0.02 | 50% |
| S_OCEAN | 3.2 ± 0.4 | 29% |
| S_LAND | 2.4 ± 0.8 | 21% |
| B_IM | ~0 | near-zero on the decade (paper); +0.02 from the annual table (my arithmetic) |

### Cumulative 1850–2024 (GtC)

Fossil 495 ± 25; land-use change 250 ± 65; total 745 ± 65. Atmosphere 290 ± 5 (39%), ocean 200 ± 40 (27%), land 175 ± 50 (24%), cumulative imbalance 80 (11%).

### 2025 projection

Fossil +1.0% (range 0.2% to 1.7%) in the final article; +1.1% (0.2% to 2.2%) in the November 2025 release that most press coverage quotes ([release card](../../sources/gcp-2025-release-nies.md), [Carbon Brief card](../../sources/carbon-brief-gcb-2025.md)). Fossil CO2 about 38.1 GtCO2 (10.4 GtC, my conversion). Land-use change projected to fall to about 4.1 GtCO2 (1.1 GtC), so total emissions about flat at 42.2 GtCO2. CO2 reaches about 425.6 ppm. Land sink projected to recover to 3.1 GtC.

## Where the emissions come from (2024)

By fuel, share of fossil total and 2023→2024 change: coal 41% (+0.8%), oil 32% (+1.3%), gas 21% (+2.4%), cement 4% (−4.6%), flaring and other about 2% ([source](../../sources/gcb-2025-essd.md), Sect. 3.1.3).

By region: China 32% (+0.7%), USA 13% (−0.6%), India 8% (+4.0%), EU27 6% (−2.6%), rest of world 41% (+1.3%, including international aviation and shipping at 3% of the global total).

Total emissions growth slowed from 1.9%/yr in 2005–2014 to 0.3%/yr in 2015–2024. Thirty-five countries, 27% of global emissions, had declining fossil emissions over 2015–2024 (Carbon Brief relaying GCB).

## Findings so far

1. **The headline numbers are now sourced** to the final GCB 2025 article, replacing the building's prior-knowledge overview. The "half stays in the atmosphere" rule of thumb holds (50% on the decade), but ocean (29%) and land (21%) are not equal shares.
2. **Land-use change is the dominant emissions-side uncertainty.** E_LUC is 1.3 ± 0.7 (54% relative), fossil is 10.3 ± 0.5 (5%). The land-use term is one-eighth the size but adds more absolute uncertainty. GCB authors call its reliability "particularly concerning".
3. **2024 does not close.** B_IM = −1.7 GtC/yr, roughly 15% of emissions and about 2.6 standard deviations outside the 2015–2024 annual spread (my arithmetic from the [annual table](../../sources/gcb-2025-data.md)). The GCB's candidate explanations: the surface network booked part of a 2023 flux anomaly into 2024 (a satellite-based growth rate of 6.8 ± 0.2 would shrink B_IM to about −0.6); vegetation models missed about 0.23 GtC/yr of 2024 fire emissions; and the models underestimate land sink loss in El Niño years. None of these is on the emissions side.
4. **Annual imbalances of ±0.5 GtC/yr are normal.** Over 2015–2024 the annual B_IM has a standard deviation of about 0.65 GtC/yr and a mean near zero, so the books close on decadal averages but not year by year.

## How this bears on the building goal (350 ppm)

Agent analysis. To get from about 426 ppm (2025) to 350 ppm requires removing roughly 76 ppm, which at 2.124 GtC per ppm is about 160 GtC from the atmosphere, before accounting for the ocean and land giving carbon back as the atmosphere falls. Current net addition to the atmosphere is 5.6 GtC/yr on the decade. The emissions side of that is 11.2 GtC/yr, of which 9.8 is fossil. The 2.124 GtC/ppm factor is my prior knowledge, not yet sourced in this building; the atmosphere desk should confirm it.

## Open questions for this desk

- Why is E_LUC uncertain by ±0.7 GtC/yr, and what is the gap between bookkeeping models, vegetation models, and national inventories? (Proposed for run 2.)
- How is the ±5% fossil uncertainty derived, and does it differ by country (China vs. OECD)?
- What are Tables 6 and 8 of GCB 2025 (decadal budgets back to the 1960s and the cumulative table)? They render as images and were not read in run 1.
- Was the 2024 land sink uncertainty ±1.1 (abstract) or ±0.9 (one Table 7 reading)? Unverified.
