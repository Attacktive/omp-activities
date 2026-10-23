import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config
(
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		rules: {
			// STYLE.md requires wrapped call arguments with the opening parenthesis on a new line, which conflicts with no-unexpected-multiline.
			'no-unexpected-multiline': 'off',
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
