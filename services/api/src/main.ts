import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3001);
  const nodeEnv = configService.get<string>(
    'NODE_ENV',
    'development',
  );
  const defaultCorsOrigins =
    nodeEnv === 'production'
      ? ''
      : 'http://localhost:3000';
  const corsOrigins = configService
    .get<string>('CORS_ORIGINS', defaultCorsOrigins)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (nodeEnv === 'production' && corsOrigins.length === 0) {
    throw new Error(
      'CORS_ORIGINS must contain at least one allowed origin in production',
    );
  }

  if (nodeEnv === 'production' && corsOrigins.includes('*')) {
    throw new Error(
      'CORS_ORIGINS must not use a wildcard in production',
    );
  }

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });

  app.setGlobalPrefix('api');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  app.useGlobalInterceptors(
    new ApiResponseInterceptor(),
  );

  const swaggerEnabled =
    configService.get<string>(
      'SWAGGER_ENABLED',
      nodeEnv === 'production' ? 'false' : 'true',
    ) === 'true';

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('FactoryOS AI API')
      .setDescription('FactoryOS AI Manufacturing SaaS API')
      .setVersion('1.0.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(
      app,
      swaggerConfig,
    );

    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(port);
}

bootstrap();