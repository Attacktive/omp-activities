import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		rules: {
			complexity: ['warn', 8],
			curly: 'warn',
			'no-undef-init': 'warn',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					ignoreRestSiblings: true
				}
			]
		}
	}
);
