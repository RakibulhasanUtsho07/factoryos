import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { ApiResponseInterceptor } from './common/interceptors/api-response.interceptor';
import {
  resolveCorsOrigins,
  resolveNodeEnvironment,
  resolveSwaggerEnabled,
} from './config/runtime-config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Bounded headroom for validated 2 MiB finance imports (base64 + JSON envelope).
  app.use(json({
    limit: '3mb',
    verify: (request: Request, _response: Response, body: Buffer) => {
      // Signature verification must use the original bytes, not re-serialized JSON.
      // Avoid retaining raw bodies on non-webhook endpoints.
      if (request.originalUrl?.split('?')[0]?.startsWith('/api/integrations/webhooks/')
        || request.originalUrl?.split('?')[0]?.startsWith('/api/v2/saas/billing/webhooks/stripe')) {
        (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(body);
      }
    },
  }));
  app.use(urlencoded({ extended: true, limit: '3mb' }));

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3001);
  const nodeEnv = resolveNodeEnvironment(
    configService.get<string>('NODE_ENV'),
  );
  const corsOrigins = resolveCorsOrigins(
    nodeEnv,
    configService.get<string>('CORS_ORIGINS'),
  );

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

  const swaggerEnabled = resolveSwaggerEnabled(
    nodeEnv,
    configService.get<string>('SWAGGER_ENABLED'),
  );

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
