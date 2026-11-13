---
title: The installer says a checkout, instance or database is already installed on the System check or the Database screen, not after the Review.
type: fixed
audience: admin
date: 2026-11-13
---
Running the interactive installer over an existing installation used to walk every screen and
be refused only after the Review and the typed `yes`. Now the **System check** — the second
screen — fails with the same sentence the run would refuse with:

- **Developer**: an **Installation** row fails on a finished install record or a sealed state
  file in the private directory. An unfinished install is still offered resume or abort first.
- **Docker** and **Trial**: the **Installation** row fails on the instance's volume, an earlier
  `.dedalo.env` or `compose.override.yaml` in the checkout, or the stack's install record.
- **Production**: the **Instance** row also fails on an install record under
  `/var/lib/dedalo-install/<instance>/`.

The **Database** screen now also refuses a database that is not empty or not owned by the
install user, as the documentation already said. Quitting the installer over a finished
install no longer says "the unfinished install is kept".
