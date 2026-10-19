# Global Carbon Budget 2025 supplemental data (annual global budget table, via openclimatedata.net)
- URL: https://openclimatedata.net/emissions/global-carbon-budget/2025/global-budget/historical-budget
- Underlying dataset: Global Carbon Project (2025), Supplemental data of Global Carbon Budget 2025, Version 1.0, DOI https://doi.org/10.18160/gcp-2025, CC BY 4.0
- Author / org: data by Global Carbon Project; page rendering by openclimatedata.net (Robert Gieseke)
- Published: dataset 2025-11 (page lists 2026-05-13)   Accessed: 2026-10-19
- Cited by: [Human emissions desk article](../wiki/desks/sources.md), [report run-001](../reports/sources/run-001.md)
- Related cards: [gcb-2025-essd](gcb-2025-essd.md)

## What it says

Annual global budget, all values GtC/yr, no uncertainties in the table. The fossil column is "fossil emissions excluding carbonation", so the cement carbonation sink is a separate column here (in the paper's headline E_FOS it is already netted out).

| Year | Fossil (excl. carbonation) | Land-use change | Atm. growth | Ocean sink | Land sink | Cement carbonation sink | Budget imbalance |
|---|---|---|---|---|---|---|---|
| 2014 | 9.68 | 1.75 | 4.31 | 3.08 | 3.04 | 0.19 | +0.81 |
| 2015 | 9.66 | 1.78 | 6.27 | 3.17 | 1.78 | 0.19 | +0.04 |
| 2016 | 9.66 | 1.47 | 6.03 | 3.29 | 1.98 | 0.19 | −0.37 |
| 2017 | 9.82 | 1.45 | 4.55 | 3.12 | 2.85 | 0.20 | +0.55 |
| 2018 | 10.03 | 1.33 | 5.08 | 3.21 | 2.88 | 0.20 | −0.01 |
| 2019 | 10.12 | 1.33 | 5.31 | 3.24 | 2.38 | 0.21 | +0.31 |
| 2020 | 9.60 | 1.23 | 4.95 | 3.24 | 2.10 | 0.21 | +0.32 |
| 2021 | 10.06 | 1.27 | 5.03 | 3.14 | 2.60 | 0.22 | +0.33 |
| 2022 | 10.24 | 1.31 | 4.86 | 3.12 | 3.11 | 0.22 | +0.24 |
| 2023 | 10.40 | 1.30 | 5.73 | 3.28 | 2.02 | 0.23 | +0.44 |
| 2024 | 10.53 | 1.25 | 7.92 | 3.39 | 1.94 | 0.22 | −1.69 |

(Values rounded here to two decimals from the four-decimal table on the page.)

## Agent analysis (Ravi, sources desk)

- Check of the identity for 2024: 10.53 + 1.25 − 0.22 − 7.92 − 3.39 − 1.94 = −1.69. Closes.
- The 2015–2024 decade mean imbalance from this table is about +0.02 GtC/yr (my arithmetic), consistent with the paper's "near-zero" claim. The year-to-year spread is the point: standard deviation of the annual imbalance over 2015–2024 is about 0.65 GtC/yr (my arithmetic, sample SD including 2024), and 2024 is a 2.6-sigma outlier even within that.
- The land sink is the swing term: it ranges from 1.78 (2015, El Niño) to 3.11 (2022, La Niña) in this decade, a factor of 1.75, while the ocean sink moves only from 3.08 to 3.39. The land desk should use this table as its baseline for Open Problem 2.
- The atmospheric growth number of 7.92 for 2024 is the single largest annual value in the record. Whether that is a real 2024 flux or partly a measurement-timing artefact (see the GRESO discussion in [gcb-2025-essd](gcb-2025-essd.md)) is the live question for the atmosphere desk.
