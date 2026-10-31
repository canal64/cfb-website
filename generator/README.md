# CFB Generator: source layers

Drop the generator's original layers here (transparent PNG, all the same size), one folder per category:

```
generator/layers/
  1-background/
  2-body/
  3-skin/
  4-eyes/
  5-top/        (hair, hats, helmets…)
  6-mouth/
  7-glasses/
  8-earrings/
```

- Name each file after the trait, e.g. `red-mohawk.png`, `diamond-teeth.png`.
- These are the **sources**: they are not served by the website as they are. They get optimized and copied to `public/` when the generator is built.
- GitHub web upload: max 25 MB per file. Big source files (Photoshop, Procreate) go elsewhere (Discord, WeTransfer) and are not committed.
- This repository is public: only upload what the author agrees to share.
